# #606 — the factory's front door: a grill skill, a confirmed brief, and a dispatch header that makes "no code from an unagreed plan" enforceable — spec **r7**

**Issue:** #606 (process, owner priority) · **C2** · worktree **y**.
**jev:** high (0.35) · C2 · worktree y (round-3 dispatch classification; the level is an observation, the pin governs)
**Spec r7:** 2026-11-27, against `9c22423` (`dev`). **Status: decision-ready.** Both boundary decisions are settled: gated class = the code-writing dispatch; boundary = option A (mandatory dispatch header, no undeclared residual).
**Rounds:** r1 → `rethink` (1 blk, 5 maj, 2 min) · r2 → `rethink` (8 maj, 1 min) · r3 → `needs-work` (5 maj, 1 min) ·
r4 → `needs-work` (3 maj, 1 min) · r5 → `needs-work` (5 maj, 2 min) · r6 → `needs-work` (3 maj, 1 min) · r7.

**Scope: Unit 1 only.** Units 2 (wiki) and 3 (vocabulary) out of scope.

---

## r6 → r7, every finding closed

| # | Finding (round 6) | r7 decision |
| --- | --- | --- |
| 1 | Falsifier (b) audited only calls *named* `read`/`grep`/`find`/`ls`, so `git show HEAD:src/router.ts` explored code without tripping it (major) | **The predicate is effect-based**: any call whose arguments cause repository content to be read, shell and interpreter included. Interval bounded by transcript entry ids; exactly two exclusions (subagent activity, non-repository sources). Authorship is **not** an exemption. The `git show` case is named as the counter-example must fail on. |
| 2 | `zero-decision-empty-reason` was requested but never specified as a test; a `none —` with no reason could pass (major) | **T12e added** with fixture `zero-decision-empty-reason` (both `none —` and `none —   `) and **M11e** (accept an empty reason). |
| 3 | Mutant arrows were predictions; nothing required executing a mutant and recording the failure; T9's M8 did not test the missing-field refusal (major) | **`## Mutation receipts`** now requires, per mutant, the applied command and the `require-executed` output (non-zero executed, the named assertion failing), and **T9 splits into T9a/T9b with M13** for the missing-field half. |
| 4 | `fenced-only` did not pin whether the `## Want` heading sits outside the fence, so M11b might be unreachable (minor) | **T12b now pins an unfenced `## Want` heading with only fenced content beneath**, plus otherwise valid decisions and marker — so the fence rule is what fails. |

## r5 → r6, every finding closed

| # | Finding (round 5) | r6 decision |
| --- | --- | --- |
| 1 | "Exactly one body line matching" was ambiguous, and with `## Settled decisions` last the marker sat in its body, so a valid zero-decision brief failed (major) | **§2 predicate 2 says "at least one non-marker body line"** and states that the marker is not body content for any predicate; fixture `zero-decision-last` pins the exact ordering. |
| 2 | P9 asked `classifyTask(body)` and `classifyTask(whole)` to agree — the behaviour §3b calls wrong (major) | **P9 now probes `resolveDispatchPreset`** and asserts equality with a body-only control, *plus* asserts that `classifyTask(whole)` differs — the second assertion is what proves the hazard and that the fix is in the caller. |
| 3 | M11 covered only the marker case; fence exclusion, answer-cell validation and zero-decision acceptance had no mutants (major) | **T12 split into T12a–T12d**, each with its own mutant (M11a–M11d) and its own fixture. |
| 4 | The template contract excluded `impl` from the enum while requiring impl-through-template, and refused missing fields at render even where the flag is absent — contradicting fail-open (major) | **`impl` is in the enum**; a missing field is refused **only when the dispatch cwd is opted in** (P13 proves the flag-absent render is untouched); an `impl` template requires `params.brief` and errors naming what is missing. |
| 5 | Falsifier (b) audited questions but not the separate "no conductor reads/greps before the plan" prohibition (major) | **Both predicates are stated and both must pass**: question-level classification **and** zero conductor `read`/`grep`/`find`/`ls` calls against repo files over the want→plan interval. |
| 6 | The author instructions told an author how to write the header but not the brief (minor) | **§3c now ships the brief-writing contract** — path, slug grammar, the four required parts, the zero-decision form and one worked example. |
| 7 | Two historical rows still described turn-ending counts and a two-outcome falsifier (minor) | **The historical tables carry a superseded notice** and the later table governs. |

## r4 → r5, every finding closed

| # | Finding (round 4) | r5 decision |
| --- | --- | --- |
| 1 | The `## Want` predicate was defeated by the marker: with `## Want` last, the `confirmed:` line is a non-heading, non-whitespace body line. Fence handling was also inconsistent (r4 excluded fenced *headings* only). (major) | **§2 is rewritten with one fence/section rule applied to every predicate, and predicate 1 explicitly excludes the confirmation marker.** Four new fixtures pin the shapes: `hollow-marker`, `fenced-only`, `empty-cell`, `zero-decision` (T12, M11). |
| 2 | Falsifier (a) stated two outcomes and omitted the normal **signed** path; `N impl · N escaped` could not establish coverage of flag-absent cwds or misdeclared tasks. (major) | **§Falsifiers (a) is now a three-outcome table** (refused · signed · escaped) with the **receipt's source and denominator defined** (spawn events + refusals in the window, plus `M excluded (flag absent)`), and both limits stated: a declaration is trusted, a flag-absent cwd is out of scope. |
| 3 | Falsifier (b) reconciled *turns ending in `?`* against a question list — not question-level coverage, since one turn can carry several questions or end in prose. (major) | **§Falsifiers (b) is question-level**: count turns containing a `?` (each opened and its questions extracted) **and** questions extracted (≥ that count), then classify each question. The two-count reconciliation is the coverage statement. |
| 4 | The block boundary was specified but not tested or explained to authors; a title before the block rejects, a blank line splits it, a later `jev:` still satisfies the old check. (minor) | **§3c adds the author-facing section on the tracked dispatch surface** (`.pi/skills/worktree/SKILL.md`): the three lines, the one-token rule, "the block is the first content", the escape, and that the Jev line may stay anywhere. P11/P12 pin the comment and title-first cases; T13 pins all three boundary behaviours. |

> **Historical (read with the table above).** The `r1/r2 → r3` and `r3 → r4` tables below record what each round changed
> *at the time*; where a later round corrected a claim (the two-outcome falsifier, the turn-level count), the later
> table governs and the older wording is retained only as the record of that round.

## r3 → r4, every finding closed

| # | Finding (round 3) | r4 decision |
| --- | --- | --- |
| 1 | **The header contaminates auto-routing**: `classifyTask` lowercases the *whole* task and matches keywords first-match-wins, so `dispatch: review` selects `code-reviewer` where the body said "write tests". (major) | **§3b: one definition, two consumers.** `splitDispatchHeader(task)` returns `{ header, body }`; the validator parses `header`, and **`resolveDispatchPreset` classifies `body`**. Falsifier + T10: adding a valid header **alone** must not change the selected preset (M9 classifies the whole task → T10 red). Verified conductor-side: `classifyTask` (src/router.ts:124) matches on `task.toLowerCase()` over the entire string, called from `src/params.ts:497`. |
| 2 | "Non-empty Want" and "one row" were not content predicates — hollow sections could pass, an honest zero-decision want was refused (major) | **§2 gives exact predicates**: section bodies are delimited by the next `^## ` heading; `## Want` needs ≥1 non-heading, non-fenced line with non-whitespace; `## Settled decisions` needs ≥1 table row whose **decision and answer cells are both non-whitespace**, **or** the explicit zero-decision form `none — <why>`. A zero-decision brief therefore has a defined, checkable outcome and a hollow table still fails. T5 pins all three shapes. |
| 3 | Evidence rows were not executable; P5 could pass without proving the check was bypassed; P8 had no control; T3/T6/T8 omitted valid-Jev preconditions; T9 had no mutant (major) | **§Evidence now names a deliverable script** (`scripts/verify-dispatch-header.mjs --case <name>`) with a pass **and** a fail assertion per case. P5 uses a **deliberately invalid** header (it must be accepted *because* the flag is off — proving the bypass). P8 gets a control (a signed same-slug brief in a fallback tree must still be refused, proving no fallback). T3/T6/T8 pin a valid `jev:` line. T9 gains **M9**. Counts are labelled **provisional** and re-measured at the implementation HEAD. |
| 4 | Falsifier (b) used a self-authored question list, which can omit or mislabel (major) | **§Falsifiers (b) is a coverage-counted reconciliation**, not a list: the audit enumerates **every** human-directed question in the session, reconciles the count against the turns that actually ended in a question, and classifies each by a checkable rule ("answerable by a command or read of the repo/environment ⇒ **fact** ⇒ fail"). Honest limit stated: a manual audit with a count, not a proof. |
| 5 | The escape contradicted the "any impl without a signed brief is refused" guarantee (major) | **The guarantee is restated as *no silent path*, not *no exceptions*.** Every `impl` dispatch is either refused or carries a surfaced, recorded escape; the receipt reports `N impl · N escaped` and may not claim universal signed-brief enforcement when an escape fired. T8 pins the exact exception. |
| 6 | The retrofit inventory was incomplete and the "83" was unlabelled and from an earlier head (minor) | **§Cost names the surfaces**: the process-check suites (provisional count), `src/__tests__/e2e-subprocess.test.ts` (real single/chain/graph dispatches on a temp cwd), legacy retry records, per-unit chain/parallel/graph text, and template bodies. All counts re-measured at the implementation HEAD; none are treated as final. |
| +7 | *(found conductor-side, not by the critic)* `validateTemplate` **silently ignores unknown frontmatter fields**, so a typo (`dispatch: reveiw`) would disable the gate with no warning | **§3a requires an enum check**: an unknown or misspelled `dispatch:` value is a **render-time error** naming the field and the allowed set (M10). |

---

## Recon (Rule 13 — codegraph @ `d186226`)

```
# classifyTask (src/router.ts:124) — lowercases the WHOLE task; first matching rule wins
# resolveDispatchPreset (src/params.ts:497) — the only auto-route caller
# validatePreTask (src/validate.ts) — early-returns on an empty task; Jev block at ~409-430 runs first
# prelude.ts:437 — the real per-unit validation site (mode-prologue.ts:143 is mode-level)
# applyTemplate (src/delegate-handler.ts:295) — template-wins: it REPLACES a supplied task
# validateTemplate (src/templates.ts:116) — validates known fields, IGNORES unknown ones
# readProcessChecks (src/project-flags.ts) — reads only <cwd>/package.json; fail-open
# router.ts:79 — dev-agent owns implement/build/code/write/add/change/modify/edit
```

- **No existing header/brief code**: `git grep -n -E 'dispatch: impl|parseBriefLine|briefs/' -- src` → 0 hits.
- **`ValidateConfig` gains no field**: the header lives in `task`.
- Real subprocess dispatches exist beyond the unit suites — `e2e-subprocess.test.ts` carries 9 `task:` occurrences
  (single, chain, graph) against a temporary cwd; they are part of the retrofit, not outside it.

---

## Decision

### 1. The grill skill — `.pi/skills/grill/SKILL.md` (adapted, not imported)

Matt Pocock's `productivity/grilling` (MIT © 2026 Matt Pocock), our frontmatter + `metadata.credits` as `pr` does.
Algorithm (stable since r1): **design tree** · **frontier** recomputed each round · **one round = the whole frontier**,
numbered, each with a **recommended answer** worded so "yes" accepts it · **wait** · **done when the frontier is
empty** ("nothing left silently assumed") · **do not act until the human confirms a shared understanding** · **facts
via subagents or `codegraph_explore`; decisions are the human's**.

### 2. The brief — `briefs/<slug>.md`, with predicates an implementer cannot soften

**Fences and sections, defined once and applied to every predicate:** a line inside a ``` fence is not a heading,
not a body line and not a table row for any predicate below. `^## ` headings **outside fences** delimit sections; a
section's body runs to the next such heading or to EOF. The gate requires **all** of:

1. `## Want` — at least one section-body line outside fences that (a) contains non-whitespace, (b) is not a heading,
   and (c) **is not the confirmation marker** (this is the hole r4 left: a `## Want` section followed only by
   `confirmed: …` is empty, not full).
2. `## Settled decisions` — **either** at least one table row outside fences, excluding the header row and the
   `|---` separator, whose **decision cell** (between the 1st and 2nd `|`) **and answer cell** (between the 2nd and
   3rd `|`) both contain non-whitespace; **or** at least one non-marker body line matching `^none —\s*\S`
   (the explicit zero-decision form: `none — not settled yet`). The confirmation marker is **not** body content for
   any predicate, so a brief whose `## Settled decisions` is the **last** section passes with
   `none — …` followed by the marker — the ordering r5 left ambiguous, pinned now by fixture `zero-decision-last`.
3. `confirmed: <YYYY-MM-DD> by <name>` — the **last non-blank line outside fences**, containing no unfilled `<…>`
   placeholder.

A **marker-only** file fails (1), a **fenced-only** Want fails (1), a row with an **empty cell** fails (2), and an
honest confirmed want with no decisions passes (2) via the `none — <why>` form — the zero-decision case has a defined
outcome instead of being an accident of whatever predicate an implementer picks. Fixtures: `hollow-marker`,
`fenced-only`, `empty-cell`, `zero-decision`, `normal`. The marker is a **record, not authentication**; the spec says
so.

### 3. The gate — a mandatory dispatch header

- **`src/dispatch-header.ts`** — one definition, two consumers:
  - `splitDispatchHeader(task)` → `{ header, body }`: the leading block starts at the first non-blank line and
    consumes consecutive lines matching `^(dispatch|brief|jev):`, ending at the first line that does not match
    (a blank line ends it too — stated, so CRLF/BOM/blank-separator cases have one answer: the block is
    `\r?\n`-split, a leading BOM is stripped before the first line is read).
  - `parseDispatchHeader(task)` → `{ ok: true, kind, brief }` | `{ ok: false, reason }`, with the forms quoted
    verbatim in every refusal:

    ```
    dispatch: impl | review | probe | docs
    brief: <slug>             (required when dispatch: impl)
    brief: none — <reason>    (the stated escape; reason non-empty)
    ```
- **`validatePreTask`**, gated by `isProcessChecksEnabled(config.cwd)` (unchanged umbrella, no new manifest key):
  1. no `dispatch:` in the leading block → **refused**, naming the block form;
  2. `dispatch: impl` + no `brief:` → **refused**;
  3. `brief: <slug>` → the file must exist **in the dispatch cwd's tree** and satisfy §2; else **refused**, naming the
     path, and for an opted-in stale worktree naming the fix (commit the brief before cutting the worktree, or rebase);
  4. `brief: none — <reason>` → **valid with a warning naming the reason**, on every validating path.
- **Slug:** `^[a-z0-9][a-z0-9-]{0,63}$`; `none` reserved; separators, dots and traversal refused — a single component,
  never a path.
- **Opt-in boundary:** the check runs iff `readProcessChecks(<dispatch cwd>)` is true. This repo's worktrees carry the
  tracked manifest, so a stale worktree **is** refused; a cwd in a tree without the flag performs no check — that is
  the flag's documented fail-open contract, not an unconsidered hole. Both are tested (P5, T6).

### 3a. Templates — how the block reaches a rendered task

`applyTemplate` **replaces** a supplied task (template-wins), so a caller cannot inject the block. Therefore:

- the template frontmatter gains `dispatch: impl | review | probe | docs`, validated as an **enum**: an unknown or
  misspelled value is an **error naming the field and the allowed set** (never silently ignored — `validateTemplate`
  ignores unknown fields today). **`impl` is in the enum**, so the impl-through-template case below has a legal form
  rather than being excluded by the enum and required by prose;
- the renderer **prepends** `dispatch: <kind>` to the rendered text, and does so **only if the body does not already
  open with a declaration** (no second declaration);
- a template with **no** `dispatch:` field is refused **only when the dispatch cwd is opted in**
  (`isProcessChecksEnabled`), with the field named. In a project without the flag it renders exactly as today — the
  render-time refusal may not leak past the fail-open boundary (P13);
- a template declaring `dispatch: impl` **must** receive `params.brief` (or the caller's stated escape) and the
  renderer composes `brief: <slug>` under it; a template declaring `impl` with no brief param is an error naming what
  is missing. (This repo's router gives implementation no template, so the path is defined for completeness, not for
  the current router.)
- retries restore the task text, so the block survives by construction.

### 3c. Author-facing instructions ship with it

The block is a new requirement on every dispatch, so it is documented where dispatches are authored:
`.pi/skills/worktree/SKILL.md` (the tracked dispatch surface that already documents the Jev line) gains a short
section — the three lines, the one-token rule (no trailing comment), "the block is the first content", the escape,
and the fact that the **Jev line may still appear anywhere** (its parser scans every line, so existing dispatches
keep working). It also carries a **"Writing a brief"** subsection — the path `briefs/<slug>.md`, the slug grammar,
the four required parts (`## Want`, `## Settled decisions`, `## Facts`, the `confirmed:` marker), the zero-decision
form and one worked example — because an author who can write the header but not the brief has half a contract. A rule
an author cannot find is a rule that will be omitted (#599's own lesson).

### 3b. Routing must not read the metadata

`classifyTask` matches keywords against the whole task, first rule wins, so a header would change the selected preset
(`dispatch: review` → `code-reviewer` where the body said "write tests"). **`resolveDispatchPreset` classifies the
`body` from `splitDispatchHeader`, never the header.** This is a correctness fix, not cosmetics: without it, adding a
mandatory line to every dispatch would silently re-route them.

### 4. The facts rule has teeth

Facts via subagents or `codegraph_explore` — never the human, never the conductor reading code. §Falsifiers (b) audits
the questions with a coverage count.

---

## Evidence (deliverable: `scripts/verify-dispatch-header.mjs --case <name>`, each with a pass **and** a fail state)

Fixtures are temp trees; an opted-in tree carries `package.json` with `processChecks: true`. Every integration case
carries a **valid `jev:`** line so the pre-existing Jev rejection cannot mask the result.

| # | Case | Pass assertion | Fail state it rules out |
| --- | --- | --- | --- |
| P1 | `header-missing` | exit 1, stderr names the `dispatch:` form | the gate is off |
| P2 | `impl-no-brief` | exit 1, stderr names the missing `brief:` line | brief ignored |
| P3 | `brief-unsigned` | exit 1, stderr names the brief path **and** the marker | marker unchecked |
| P4 | `brief-hollow` | exit 1 (empty `## Want` body; §2 predicate 1) | structure unchecked |
| P5 | `flag-absent` with a **deliberately invalid** header | exit 0 **and** prints `no check (processChecks absent)` | the check leaking into a non-opted-in tree |
| P6 | `review-header` | exit 0, valid | the gate is too wide |
| P7 | `slug-../x`, `slug-a/b`, `slug-none` | exit 1 each, naming the grammar | traversal |
| P8 | `stale-tree` **and** its control: the same slug signed in a fallback tree | both exit 1, naming the cwd's path (the control proves **no** fallback) | a silent fallback to another tree |
| P9 | `routing` — call **`resolveDispatchPreset`** on a (header, body) pair; separately call `classifyTask` on the whole task | `resolveDispatchPreset` selects the **same** preset as the body-only control, **and** `classifyTask(whole)` is asserted to select a *different* one | the §3b contamination (the second assertion proves the hazard was real and that the fix is in the caller, not the classifier) |
| P10 | `template-no-field` / `template-typo` | exit 1 each, naming the field and the allowed set | a silently ignored frontmatter field |
| P11 | `dispatch-with-comment` (`dispatch: impl   # note`) | exit 1, naming the one-token rule | ambiguous trailing text accepted |
| P12 | `title-first` (a `# Task` line before the block) | exit 1, naming "the block must be the first content" | a title silently accepted before the block |
| P13 | `flag-absent-template` (a template with no `dispatch:` field, dispatched from a cwd without the flag) | exit 0, renders and dispatches exactly as today | the render-time refusal leaking past the fail-open boundary |

## Tests (fixture preconditions pinned; each mutant names its predicate and the test it reddens)

| # | Test | Precondition | Mutant → red |
| --- | --- | --- | --- |
| T1 | parser: four kinds accepted; missing `dispatch:`, unknown kind, empty escape reason refused | — | M2 (accept empty reason) → T1 |
| T2 | `impl` + no brief refused, message names the form | opted-in cwd, valid Jev | M1 (delete the brief branch) → T2 |
| T3 | a review task **quoting** `dispatch: impl` (inline and fenced) stays valid | opted-in cwd, valid Jev | M3 (scan the whole text) → T3 |
| T4 | slug: `../x`, `a/b`, `none`, `A`, `""` refused; `consider-tax` accepted | — | M4 (accept any string) → T4 |
| T5 | marker-only refused; **hollow table row** refused; `none — <why>` form accepted; Want+row+marker accepted | briefs fixtures | M5 (marker alone suffices) → T5 |
| T6 | opted-in stale cwd refused; **manifest-less cwd → no check** | two trees, valid Jev | M6 (skip when file absent) → T6 |
| T7 | integration: refusal reaches **zero spawns** with a valid Jev, message brief-specific; signed-brief control **does** spawn | existing `dispatch-line-enforcement` harness | M1 → T7; Jev alone cannot redden it |
| T8 | escape valid **and** warns on all four validating paths | opted-in cwd, valid Jev | M7 (silent escape) → T8 |
| T9a | template renders `dispatch: <kind>` | template fixture | M8 (drop the prepend) → T9a |
| T9b | a template with **no** `dispatch:` field is refused at render (opted-in cwd) | template fixture | M13 (permit a missing field) → T9b |
| T10 | **adding a valid header alone does not change the selected preset** | a routing fixture pair | M9 (classify the whole task) → T10 |
| T11 | unknown/misspelled `dispatch:` frontmatter value is a render error naming the field | template fixture | M10 (ignore unknown fields) → T11 |
| T12a | `hollow-marker` refused (marker is not Want content) | briefs fixture | M11a (count the marker as Want content) → T12a |
| T12b | `fenced-only` refused — fixture pins an **unfenced** `## Want` heading with only fenced content beneath it, plus otherwise valid decisions and marker (so the fence rule, not a missing heading, is what fails) | briefs fixture | M11b (count fenced lines as body) → T12b |
| T12c | `empty-cell` refused (answer cell must be non-whitespace) | briefs fixture | M11c (skip the answer-cell check) → T12c |
| T12d | `zero-decision-last` **accepted** (`none — …` then the marker, Settled decisions last) | briefs fixture | M11d (reject the zero-decision form) → T12d |
| T12e | `zero-decision-empty-reason` **refused** (`none —` and `none —   ` both) | briefs fixtures | M11e (accept an empty reason) → T12e |
| T13 | block boundary: comment on `dispatch:` refused; title before the block refused; a `jev:` line **later** in the body still satisfies the existing Jev check | boundary fixtures | M12 (accept any `dispatch:` line) → T13 |

All filtered runs quote `node scripts/require-executed.mjs` (#591).

---

## Mutation receipts — a predicted kill is not a kill

Every `M<n>` above is a **claim to be measured, not asserted**. The implementation report must carry, per mutant, the
command that applied it and the `node scripts/require-executed.mjs -- npx vitest run <file>` output for the test it
names: the executed count must be non-zero and the named assertion must be the one that failed (`failed 1`, naming the
test). A row whose mutant produces `0 executed`, or that fails a *different* test, is an unmeasured claim and the row
is not closed. The reviewer reproduces at least one mutant per surface; `merge-guard`'s existing test-flow check does
not see this, so it is the review record's job to say the receipts were read.

## Falsifiers

**(a) No silent path — three outcomes, not two.** Every `impl` dispatch ends in exactly one of:

| Outcome | Meaning |
| --- | --- |
| **refused** | no spawn; the validator returned an error naming the missing form |
| **signed** | spawned with a brief that satisfied §2 |
| **escaped** | spawned with `brief: none — <reason>`; the reason is surfaced as a warning **and** present in the payload |

**Receipt.** Source: the spawn events in `.pi/subagent-logs/brl-subagent.log` plus the refusal entries in the same
window. Denominator: every spawn event whose dispatch cwd had the flag **on**, plus every refusal. The line reads
`N impl · N signed · N escaped · N refused`, and separately reports `M dispatches excluded (flag absent)`. Two limits
are stated, not hidden: a code-writing task **declared** as another kind is trusted (the declaration is the contract,
not a guess), and a flag-absent cwd is out of scope by the flag's own fail-open contract. The receipt may never claim
universal signed-brief enforcement while an escape or an exclusion exists.

**(b) The facts rule — question-level coverage.** At the next real want, enumerate **questions, not turns**: every
interrogative the conductor put to the human, including **several in one turn** and **a question followed by prose**.
Coverage is reconciled in two counts — *turns containing a `?`* (all of which must be opened and their questions
extracted) and *questions extracted* (≥ that count) — because a turn-level count is what r3 correctly rejected. Each
question is then classified by the checkable rule *"answerable by a command or read of the repo/environment ⇒ fact ⇒
fail"*. **And the prohibition is two-sided**, because the issue names two. Over the interval *the want is stated → the plan
is persisted* — bounded by **transcript entry ids**, never by memory — no repository file content may enter the
conductor's transcript **by any route**. The predicate is **effect-based, not tool-name-based**: a call counts if its
arguments cause repository content to be read — `read`, `grep`, `find`, `ls`, **and** `bash` running `cat`, `head`,
`tail`, `sed`, `awk`, `git show`, `git diff`, `wc`, or an interpreter that opens a repo path. Two exclusions, and only
two: **subagent activity** (that is how facts were meant to arrive) and **non-repository sources** (network, the
private scratch root). A repository file the conductor *authored* is still a repository file — authorship is **not**
an exemption, and r6's wording wrongly implied one. The measured counter-example this rule exists for:
`git show HEAD:src/router.ts | head -5` prints repository code with no prohibited tool name, and **must** fail the
receipt. **Either** predicate failing fails the receipt — a session that asks no fact questions but reads the code
directly still fails.

Honest limit: a manual audit with two coverage counts,
not a proof.

---

## Cost (measured at the implementation HEAD; these numbers are provisional)

Surfaces the retrofit must cover, all named:

- the process-check suites (the earlier "3 files / 83 tests" was taken at another head — **provisional**);
- `src/__tests__/e2e-subprocess.test.ts` — real single, chain and graph dispatches against a temporary cwd;
- legacy retry records (a restored task predating the header);
- per-unit chain/parallel/graph task text (validated at `src/prelude.ts:437`);
- the 5 project-local and 9 shipped templates (one frontmatter line each);
- `.pi/skills/worktree/SKILL.md`, which gains the author-facing section (§3c) — the change must be discoverable at the
  point of use, not only in this spec.

No schema change, no new tool parameter, no new manifest key, no preset resolution, no batch plumbing.

## Filed, not fixed here

`noJev`'s guard (`COERCED_PRIMITIVE_RE` via `readNoJevReason`) accepts exponent-form numbers (`1e+21`, `1e-7`) through
the real `coerce: true` path. A shipped-code defect with its own fix and test; r4 does not depend on it.

## Out of scope

Unit 2 (wiki index) · Unit 3 (vocabulary + forbidden-synonym lint, including the worktree→runner persistence hazard) ·
#599/#602/#603 and `scripts/dispatch.mjs` · `/grill` as a user command · round/question caps.

## Upstream (adapt, don't import)

`mattpocock/skills` @ `6f7f7831a625f040a8e06a0e7954826b87ce775a` (MIT © 2026 Matt Pocock), primary file
`skills/productivity/grilling/SKILL.md` (blob `d2f09a18…`); verbatim capture in
`.development/investigations/issue-606-grilling-upstream-2026-11-27.md`. Persistence, the refusal and fact-provenance
are Unit 1 **additions**.

# #606 — the factory's front door: a grill skill that turns a want into a confirmed brief, and a pre-flight that refuses a *code-writing* dispatch without one — spec **r2**

**Issue:** #606 (process, owner priority) · **C2** · worktree **y**.
**jev:** medium (0.89) · C2 · worktree y (r1 dispatch; the critique's recheck was `medium (0.5) · C2`)
**Spec r2:** 2026-11-27, against `7933432` (`dev`). **Status: decision-ready for review — one open decision (§0).**
**Supersedes:** r1 (same file, same day). Critique r1 returned **`rethink`** — 1 blocker, 5 majors, 2 minors.

**Scope: Unit 1 only** (the grill + the gate). Units 2 (wiki) and 3 (vocabulary) remain out of scope.

---

## 0. The one decision this revision needs from the human

The blocker was a **definitional** mismatch, not a mechanic: r1 gated `project-implementer` dispatches while the
issue says *"a plan dispatch without a signed brief is refused"*. Two readings exist, and the spec must pick one —
this is a decision, not a fact:

| Reading | What is gated | Consequence |
| --- | --- | --- |
| **A — implementation is the gate** (recommended) | every dispatch that **writes code** (`project-implementer`, plus any task declaring `kind: impl`) | The brief is planning's **output**; gating planning would invert causality and make the grill unrunnable (`project-proposer` exists to *generate* the options a grill settles). |
| B — "planning" is the gate | `project-proposer` design-proposal dispatches | Would require a brief **before** the dispatch that generates the material for one, and would leave code-writing dispatches ungated. |

**Recommendation: A.** A brief is a set of *settled decisions*; a design proposal is how unsettled decisions get
options. The rule the issue wants — *no code from an unagreed plan* — is exactly reading A. Everything below
assumes A; if the human picks B, §3's trigger changes and the rest stands.

---

## r1 → r2, finding by finding

| # | Critique finding (sev) | r2 decision |
| --- | --- | --- |
| 1 | `project-implementer` identifies implementation, not planning — gate misses design proposals, catches later implementation (blocker) | **§0 states the gated class explicitly as code-writing dispatches, with the reasoning and the rejected alternative.** The class is not "planning" but "the dispatch that writes code", because the brief is planning's output. Two-sided falsifier added (§Tests T3: a review dispatch must NOT be gated). |
| 2 | `brief: unavailable` passes as `ok` with no reason; `{ok}` carries no slug (major) | **Removed entirely.** The only escape is an explicit stated-reason line (§3). The parser returns `{ ok: true, slug }` so the file resolver gets the slug — no second regex. |
| 3 | `noBrief` is a new **tool parameter**: schema, known-key, mode, retry, provenance seams; `snapshotOriginalParams` omits `noJev` (major) | **No parameter.** The escape is a **task-text line** `brief: none — <reason>`. Rationale: the task text is restored on retry (the exact seam the critique measured missing for `noJev`) and lands in the dispatch payload, which is the durable record. Cost stated: a line, not a typed param. |
| 4 | `readNoJevReason` does not refuse exponent-form numbers (`1e+21`, `1e-7` measured through the real coercion path) (major) | **The plan no longer reuses it** (no parameter ⇒ no coercion surface). The underlying hole is a defect in *shipped* code — **filed separately, not fixed here** (§Filed). |
| 5 | The falsifier-(a) test could pass with the feature removed: the Jev gate already rejects before spawn; no Evidence/Tests sections (major) | **§Tests now names 6 tests with mutants and measured killers, including the discrimination that makes it brief-specific:** valid Jev line + brief refusal whose message is brief-specific, plus a confirmed-brief spawn control. §Evidence added per `references/spec-evidence.md`. |
| 6 | Falsifier (b) measures conductor reads only, so it can pass while lookupable facts were asked of the human (major) | **Two predicates, both audited** at the next real want: zero conductor reads/greps, **and** every fact in the brief's `## Facts` table carries a subagent run id or a `codegraph_explore` query. A violation under either fails. |
| 7 | Committing the brief to `dev` does not place it in a worktree cut from an older commit (minor) | **Stated rule + test:** the brief must exist in the dispatch cwd *at the commit that cwd contains*; a stale worktree refuses, naming the path and the fix (rebase/recreate, or a stated escape). §Tests T6. |
| 8 | `/^confirmed:/i` accepts a bare marker or a template placeholder (minor) | **Marker requires content:** `confirmed: <YYYY-MM-DD> by <name>`. Bare, placeholder (`<…>`) and undated markers are refused. The spec states plainly that this is a **textual marker, not authentication**. §Tests T5. |

---

## Recon (Rule 13 — codegraph @ `7933432`, refreshed)

```
# validatePreTask (src/validate.ts) — the refusal lands inside it, as a sibling of the Jev block
# parseDispatchLine (src/dispatch-line.ts) — the analog: pure parser, verbatim FORM string, gap marker
# resolvedPreset / resolveSubagentParams (src/params.ts) — where the preset NAME is resolved
```

- **Preset resolution precedes validation** (critique-verified at `7933432`): foreground and background both
  resolve before `validatePreTask` runs, so the resolved name can be forwarded without a second resolution.
- **`ValidateConfig` has no preset field today** (`task`, `toolOptions`, `thinkingLevel`, `gitMode`, `outputFile`,
  `force`, `cwd`, `noJev`) — r2 adds one.
- **Five `ValidateConfig` construction sites, not two** (r1 said "two prod call sites" — wrong):

  | Site | Shape |
  | --- | --- |
  | `src/delegate-handler.ts:1045` | foreground dispatch |
  | `src/prelude.ts:437` | shared pre-task wrapper |
  | `src/background-pipeline.ts:314` | background spawn |
  | `src/background-pipeline.ts:914` | background fan-out unit |
  | `src/mode-prologue.ts:143` | **batch per-unit validation** (chain/parallel/graph) |

  The batch site is why the preset must be *forwarded*: a unit may name its own preset, else the global resolved
  preset applies. A unit caller that resolves nothing passes nothing, and the check degrades to the text marker.
- `readProcessChecks` is fail-open; `PROCESS_CHECK_KEYS` contains only `processChecks` and **r2 adds no key**
  (the umbrella flag is reused as-is).
- `git grep -n -E 'noBrief|parseBriefLine|briefs/' -- src` → **no hits** (no prior art to collide with).

---

## Decision

### 1. The grill skill — `.pi/skills/grill/SKILL.md` (adapted, not imported)

Adapt Matt Pocock's `productivity/grilling` (MIT © 2026 Matt Pocock) in our frontmatter format, with
`metadata.credits` as `pr` does. Unchanged from r1; the algorithm:

- **Design tree** of decisions, built during the interview.
- **Frontier** = decisions whose prerequisites are settled — askable *now* without guessing at an unheard answer;
  recomputed each round, never a pre-baked list.
- **One round = the whole frontier**, numbered, each with a **recommended answer** worded so "yes" accepts it
  (`❓ **Qn** - **<title>**: <body>` / `➡️ <recommendation>`; `---` between questions). A question depending on
  another still-open question moves to a *later* round.
- **Wait** for the answers; settled decisions push the frontier outward.
- **Terminate when the frontier is empty** — every branch visited, *nothing left silently assumed* — and
  **do not act until the human confirms a shared understanding** (upstream's exact gate).
- **Facts vs decisions:** facts are the conductor's job via subagents or `codegraph_explore`; decisions are the
  human's.

### 2. The durable brief — `briefs/<slug>.md`, ending in a content-bearing confirmation marker

Tracked, committed to `dev` before the dispatch that needs it. Structure unchanged from r1 (Want · Settled
decisions · Facts · Last frontier), with two corrections:

- **The marker carries content:** last non-blank line `confirmed: <YYYY-MM-DD> by <name>`; a bare `confirmed:`, an
  undated one, or one containing an unfilled `<…>` placeholder is **not** a signed brief. The spec says plainly
  what this is: a **textual marker, not authentication** — it records that the human confirmed, and anyone with
  write access could forge it. The brief is a record, not a signature.
- **The `## Facts` table is the fact-provenance artifact:** each fact names a subagent run id or a
  `codegraph_explore` query. §4 and falsifier (b) read this table.

### 3. The refusal — a code-writing dispatch without a signed brief is refused before spawn

- **New `src/brief-line.ts`** — a pure parser in the `dispatch-line.ts` mould: `parseBriefLine(task)` returns
  `{ ok: true, slug }` | `{ ok: true, escape: reason }` | `{ ok: false, reason }`, with
  `BRIEF_LINE_FORM = "brief: <slug>"` and `BRIEF_ESCAPE_FORM = "brief: none — <reason>"` quoted verbatim in every
  rejection. **There is no "unavailable" form** (r1's silent `ok` is gone): an escape must state a non-empty reason,
  and it is surfaced as a warning.
- **`src/validate.ts` `validatePreTask`** — a block beside the Jev check, gated by the **same**
  `isProcessChecksEnabled(config.cwd)` umbrella:
  - **Gated class (the blocker's answer):** `config.presetName === "project-implementer"` **or** the task carries
    `kind: impl`. Both arms matter: the preset arm covers the router's prescribed path with no new line to
    remember; the text arm covers an implementation routed without the preset. A dispatch in neither arm is not
    gated (stated residual, §Residual).
  - **Three refusal conditions, distinguishable in the message:** no `brief:` line; the named `briefs/<slug>.md`
    missing **in the dispatch cwd's tree**; the file present but without a content-bearing marker. Each names the
    path it looked for and the form to use.
  - `brief: none — <reason>` → passes with a **warning that names the reason** (ADR 0007's shape), so the bypass is
    surfaced in the result and recorded in the task payload, never silent.
- **`ValidateConfig.presetName?: string`** forwarded at all **five** construction sites (Recon table); batch units
  forward their own resolved preset, else the global one.
- **No new manifest key, no new tool parameter, no schema change** — the escape lives in the task text.

### 4. The facts rule has teeth

Facts come from subagents or `codegraph_explore` — never the human, never the conductor reading code. The brief's
`## Facts` table is the provenance, and falsifier (b) audits **both** predicates (§Falsifiers).

---

## Evidence (per `references/spec-evidence.md` — command **and** the assertion it must satisfy)

| # | Command | Assertion |
| --- | --- | --- |
| E1 | `rg -n 'isProcessChecksEnabled' src/validate.ts` | the brief block sits inside `validatePreTask`, after the Jev block and before the tool loop; the flag is read once per call, not twice |
| E2 | `rg -n 'presetName' src/` | 5 construction sites carry it (the Recon table) and **no** sixth site constructs `ValidateConfig` |
| E3 | `node -e 'require("./src/presets")'`-style probe via the loader | `project-plan-critic`/`project-proposer`/`project-reviewer` are **not** gated; `project-implementer` is (two-sided) |
| E4 | `git grep -n 'briefs/' -- src` at the base sha | **0 hits** before the change; no prior art to collide with |
| E5 | malformed-manifest probe against `readProcessChecks` | still `false`; `PROCESS_CHECK_KEYS` still `["processChecks"]` (no new key) |

## Tests (each row names its **negative control** and a **measured killer**)

| # | Test | Negative control / mutant → the row this must redden |
| --- | --- | --- |
| T1 | `parseBriefLine` accepts `brief: <slug>`; refuses a missing line, an empty slug, and `brief: none —` with no reason | M2: accept an empty escape reason → T1 red |
| T2 | validator refuses a **valid-Jev** task with `kind: impl` and a missing brief, message brief-specific | M1: delete the brief block → T2 red; a Jev-only rejection does **not** satisfy T2 (asserted on the message) |
| T3 | **control:** a `project-reviewer` dispatch with no brief is **valid** (two-sided falsifier) | M3: gate every dispatch → T3 red |
| T4 | `brief: none — <reason>` passes **and** emits a warning naming the reason | M4: pass silently without the warning → T4 red |
| T5 | marker: bare `confirmed:`, undated, and `<…>`-placeholder markers are refused; `confirmed: 2026-11-27 by azmeen` passes | M5: accept a bare marker → T5 red |
| T6 | dispatch cwd whose tree lacks `briefs/` → refusal naming the path; same tree with the file → passes | M6: fall back to the cockpit tree → T6 red |
| T7 | integration: refusal path reaches **zero spawns**; the confirmed-brief control **does** spawn (the existing `dispatch-line-enforcement` harness) | M1 → T7 red; the Jev gate alone cannot redden it |

A filtered run quotes `node scripts/require-executed.mjs` (a `-t` filter matching nothing exits 0 — #591).

---

## Falsifiers

**(a)** A gated dispatch (preset arm **or** `kind: impl`) with no `brief:` line, a missing brief file, or no
content-bearing marker is **refused before spawn** — T2 + T7, and M1 reddens both. A confirmed brief spawns (T7
control); an unrelated dispatch is not gated (T3).

**(b)** At the next real want, **both** predicates hold: (i) the conductor's transcript contains no file reads or
greps before the plan exists; (ii) no lookupable fact was put to the human — every fact in the brief's `## Facts`
table names a subagent run id or a `codegraph_explore` query. A violation under **either** fails. Honest limit: this
is a next-cycle receipt, not a result this build can produce; it is not dressed up as evidence.

---

## Residual (stated, not hidden)

An implementation dispatch that names **neither** `project-implementer` **nor** `kind: impl` is not gated. That is
the same opt-in weakness #599 documents (a brief that omits the bank is a *successful* dispatch) and the same place
it closes: #599's `dispatch.mjs brief --kind impl` emits the kind, so the generated brief always carries it. Named
here so it is a known edge, not an oversight.

## Filed, not fixed here

The critique measured a live defect in **shipped** code: `noJev`'s guard (`COERCED_PRIMITIVE_RE` via
`readNoJevReason`) accepts exponent-form numbers (`1e+21`, `1e-7`) arriving through the real `coerce: true` path, so
a numeric bypass can pass as a stated reason. r2 removes the plan's dependence on that guard; the hole itself wants
its own fix + test. Filed as a separate issue (not a Unit 1 deliverable).

## Out of scope

Unit 2 (wiki index over pages) · Unit 3 (task/trigger/run/runner/ticket-tracker vocabulary + the forbidden-synonym
lint, including the worktree→runner persistence hazard the upstream capture flags) · #599/#602/#603 and
`scripts/dispatch.mjs` · `/grill` as a user command · a round/question cap.

## Upstream (adapt, don't import)

`mattpocock/skills` @ `6f7f7831a625f040a8e06a0e7954826b87ce775a` (main, 2026-11-25), MIT © 2026 Matt Pocock.
Primary file `skills/productivity/grilling/SKILL.md` (blob `d2f09a18…`); full verbatim capture in
`.development/investigations/issue-606-grilling-upstream-2026-11-27.md`. The three things Unit 1 **adds** that upstream
does not specify — persistence (`briefs/`), the refusal, and fact-provenance — are stated as additions, never as
inheritances.

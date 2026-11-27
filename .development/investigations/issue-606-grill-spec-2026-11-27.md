# #606 — the factory's front door: a grill skill, a confirmed brief, and a dispatch header that makes "no code from an unagreed plan" enforceable — spec **r3**

**Issue:** #606 (process, owner priority) · **C2** · worktree **y**.
**jev:** medium (0.89) · C2 · worktree y
**Spec r3:** 2026-11-27, against `30448e8` (`dev`). **Status: decision-ready — one boundary decision (§0.2), recommended and written in.**
**Rounds:** r1 → critique `rethink` (1 blocker, 5 majors, 2 minors) → r2 → critique `rethink` (8 majors, 1 minor) → r3.

**Scope: Unit 1 only** (the grill + the gate). Units 2 (wiki) and 3 (vocabulary) remain out of scope.

---

## 0. Two decisions

### 0.1 The gated class — **SETTLED** (maintainer, 2026-11-27): the code-writing dispatch

A brief is planning's **output**; `project-proposer` exists to *generate* the options a brief settles, so gating it
would invert causality and leave code-writing ungated. Reading B ("planning is the gate") is recorded as rejected so
it is not silently lost.

### 0.2 The classification boundary — **r3 answer, needs the maintainer's acceptance**

Both critiques killed every *inferable* identity, and the second one proved the decisive fact: **`src/router.ts:79`
routes `implement`/`build`/`code`/`write`/`add`/`change`/`modify`/`edit` to `dev-agent`**, so the preset arm missed the
*ordinary* implementation dispatch. Any identity the caller can omit — a preset, a keyword, an auto-route — is not a
gate. #599's generator is the eventual source of a declaration, but it is open and enforces nothing today.

| Option | Boundary | Consequence |
| --- | --- | --- |
| **A — mandatory dispatch header** (**ADOPTED in r3**) | every dispatch's own task text must open with a `dispatch:` declaration | Absence is itself a refusal, so falsifier (a) holds for *every* dispatch with no residual. No preset resolution, no per-unit schema, no batch plumbing. Cost: every dispatch in this repo carries a 3-line leading block, and the existing process-check fixtures (3 files / 83 tests) gain it — mechanical. |
| B — narrow the guarantee | gate only *declared* `dispatch: impl` dispatches; a dispatch that declares nothing is not gated | Zero cost, but the falsifier becomes "a **declared** code-writing dispatch without a brief is refused" — the ordinary auto-routed implementation escapes, which is the hole both critiques filed. Acceptable only as an explicit maintainer narrowing, never as an unstated residual (r2's §Residual did exactly that and was the blocker). |

**Recommendation: A**, and r3 is written for it. If B is chosen, §3's "missing `dispatch:` is a refusal" line is
deleted and the guarantee is restated as declared-only; nothing else changes.

---

## r1/r2 → r3, every finding accounted for

| # | Finding (round) | r3 disposition |
| --- | --- | --- |
| 1 | Preset arm misses the ordinary implementation dispatch — `dev-agent` is the router's implementation route; #599 open (blk/r1, maj/r2) | **Preset identity removed entirely.** §3's boundary is a declaration in the task text; `project-implementer` and `dev-agent` are both covered, and no resolution or forwarding is involved. |
| 2 | `brief: unavailable` passed as `ok`; `{ok}` carried no slug (maj/r1) | Gone. One escape, `brief: none — <reason>`, which returns the parsed reason for the warning. |
| 3 | `noBrief` was a new tool parameter (schema/known-key/retry/provenance) (maj/r1) | Gone — the escape is a line in the dispatch header, so the task text (restored on retry, present in the payload) carries it. No schema change. |
| 4 | `noJev`'s guard accepts exponent numbers (maj/r1) | Not used, not fixed here; filed as separate shipped-code work (§Filed). |
| 5 | Falsifier (a)'s test could pass with the feature removed (maj/r1) | §Tests T7 carries a **valid** `jev:` line and asserts the **brief-specific** refusal, so Jev cannot mask it; M1 reddens it. Every mutant names the predicate it mutates and the test that reddens. |
| 6 | Falsifier (b) measured reads, then (r2) table provenance — neither proves no lookupable question was asked (maj/r1, maj/r2) | §Falsifiers (b) is rewritten: **the audit is over human-directed questions**, each labelled decision or fact; one fact-question fails the receipt regardless of the Facts table. |
| 7 | A marker-only file satisfied the gate; #606 requires decisions and the human's words (maj/r2) | §3 now requires a **minimum brief structure** (`## Want` non-empty, `## Settled decisions` with ≥1 row, plus the content-bearing marker). T5 pins it. |
| 8 | The stale-worktree guarantee was conditional on the cwd opting in (maj/r2) | §3's **opt-in boundary** is stated exactly (flag read from `<cwd>/package.json`; worktrees carry the tracked manifest; a tree without it is out of scope by the flag's own contract) and **both** cases are tested (P5/T6). No unconditional-refusal claim. |
| 9 | Batch per-unit validation site misidentified; units have no preset (maj/r2) | Moot: the header lives in each unit's **task text**, validated at `src/prelude.ts:437`. No preset, no forwarding, no sixth site to find. |
| 10 | `kind: impl` had no parse boundary — prose or a fenced quote could trigger it (maj/r2) | §3 anchors the declaration to a **leading block** (first non-blank lines), so a later quote cannot satisfy it. T3 pins the quoted-fenced case. |
| 11 | Evidence rows were not executable (maj/r2) | §Evidence is a set of **probe scripts with pass and fail states** (P1–P6), quoted at the implementation HEAD; `rg` rows that survive a deleted feature are gone. |
| 12 | `<slug>` had no grammar; traversal escaped `briefs/` (min/r2) | §3 pins `^[a-z0-9][a-z0-9-]{0,63}$`, reserves `none`, and refuses traversal/separators. T4 pins the traversal input. |

---

## Recon (Rule 13 — codegraph @ `30448e8`; the two decisive facts verified conductor-side)

```
# validatePreTask (src/validate.ts) — early-returns on an empty task; Jev block runs first, at lines ~409-430
# prelude.ts:437 — the REAL per-unit validation site (merged unit params → runPreTaskValidation)
# mode-prologue.ts:143 — mode-level, NOT per-unit (r2's Recon was wrong about this)
# readProcessChecks (src/project-flags.ts) — reads only <cwd>/package.json; fail-open
# router.ts:79 — dev-agent owns the implementation keywords
```

- **`dispatch-line-enforcement.test.ts:280`** already asserts a Jev-only zero-spawn rejection — which is precisely why
  r1's falsifier test was vacuous, and why T7 must supply a valid `jev:` line.
- `ValidateConfig` today: `task`, `toolOptions`, `thinkingLevel`, `gitMode`, `outputFile`, `force`, `cwd`, `noJev`.
  **r3 adds no field** — the header lives in `task`.
- `git grep -n -E 'noBrief|parseBriefLine|briefs/|dispatch: impl' -- src` → **no hits** (no prior art).
- Existing process-check suites: **3 files / 83 tests**; their fixtures gain the header (mechanical, named cost).

---

## Decision

### 1. The grill skill — `.pi/skills/grill/SKILL.md` (adapted, not imported)

Adapt Matt Pocock's `productivity/grilling` (MIT © 2026 Matt Pocock), our frontmatter + `metadata.credits` as `pr`
does. The algorithm, unchanged across rounds: **design tree** · **frontier** (decisions whose prerequisites are
settled; recomputed each round) · **one round = the whole frontier**, numbered, each with a **recommended answer**
worded so "yes" accepts it · **wait** for answers · **terminate when the frontier is empty** ("nothing left silently
assumed") · **do not act until the human confirms a shared understanding** · **facts are the conductor's job**
(subagents or `codegraph_explore`), **decisions are the human's**.

### 2. The durable brief — `briefs/<slug>.md`

Tracked, committed **before** the worktree is cut (so it is present in the dispatch tree). Minimum structure the gate
enforces:

```
## Want
<the human's words, non-empty>

## Settled decisions
| # | Decision | Human's answer |
|---|---|---|
| 1 | … | … |            ← at least one row

## Facts
| Fact | Source (subagent run id · codegraph_explore query) |

confirmed: <YYYY-MM-DD> by <name>     ← last non-blank line; content-bearing
```

A **marker-only** file fails (T5). The marker is a **record, not authentication** — anyone with write access could
forge it, and the spec says so rather than implying a signature.

### 3. The gate — a dispatch header, mandated for every dispatch in an opted-in project

- **New `src/dispatch-header.ts`** — a pure parser: `parseDispatchHeader(task)` reads the **leading block** (from the
  first non-blank line, consuming consecutive lines matching `^(dispatch|brief|jev):`) and returns
  `{ ok: true, kind, brief }` | `{ ok: false, reason }`. Forms, quoted verbatim in every refusal:

  ```
  dispatch: impl | review | probe | docs
  brief: <slug>             (required when dispatch: impl)
  brief: none — <reason>    (the stated escape; reason non-empty)
  ```
- **Anchoring is positional, not textual.** A declaration is metadata only in that leading block, so a review task
  that quotes the form — inline or in a fence — cannot satisfy or trip it (T3).
- **`validatePreTask`**, gated by `isProcessChecksEnabled(config.cwd)` (unchanged umbrella, no new manifest key):
  1. no `dispatch:` in the leading block → **refused**, naming the block form. *(This is option A; option B deletes
     this step and restates the guarantee as declared-only.)*
  2. `dispatch: impl` + no `brief:` → **refused**.
  3. `brief: <slug>` → the file must exist **in the dispatch cwd's tree** and pass §2's structure check; otherwise
     **refused**, naming the path, and — for a stale worktree — naming the fix (commit the brief before cutting the
     worktree, or rebase it).
  4. `brief: none — <reason>` → **valid with a warning** that names the reason (ADR 0007's shape), on every validating
     path (foreground, background spawn, fan-out, batch unit).
- **Slug grammar:** `^[a-z0-9][a-z0-9-]{0,63}$`; `none` reserved; separators, dots and traversal refused — the slug is
  a single path component, never a path.
- **Opt-in boundary, stated exactly:** the check runs iff `readProcessChecks(<dispatch cwd>)` is true. This repo's
  worktrees carry the tracked `package.json`, so a worktree is opted in and a stale one **is** refused. A cwd under a
  tree without the flag performs no check — that is the flag's documented, fail-open contract (our process, never a
  user's), not an unconsidered hole. Both cases are tested (P5, T6).

### 4. The facts rule has teeth

Facts come from subagents or `codegraph_explore` — never the human, never the conductor reading code. §Falsifiers (b)
audits the *questions*, not just the table.

---

## Evidence (each probe has a pass **and** a fail state; quoted at the implementation HEAD)

| # | Probe (fixture: a temp opted-in tree, `processChecks: true`) | Pass state | Fail state |
| --- | --- | --- | --- |
| P1 | `node scripts/<probe>.mjs --case header-missing` | exit 1, message contains `dispatch:` form | exit 0 or a generic message |
| P2 | `--case impl-without-brief` | exit 1, message names the missing `brief:` line | passes |
| P3 | `--case brief-unsigned` (file present, no marker) | exit 1, message names the brief path + the marker | passes |
| P4 | `--case brief-signed` (Want + one decision + marker) | exit 0, valid | refused |
| P5 | `--case no-manifest-cwd` | exit 0 and the probe prints `no check (flag absent)` | any check runs |
| P6 | `--case review-header` | exit 0, valid — the two-sided control | refused (the gate is too wide) |
| P7 | `--case slug-../x`, `--case slug-a/b`, `--case slug-none` | exit 1 each, naming the grammar | accepted |
| P8 | `--case stale-tree` (opted-in cwd whose tree lacks the file) | exit 1, names the path + the fix | silently falls back to another tree |

## Tests (fixture preconditions named; each mutant names the predicate it mutates and the test it reddens)

| # | Test | Precondition | Mutant → expected red |
| --- | --- | --- | --- |
| T1 | header parser: accepts the four kinds; refuses a missing `dispatch:`, an unknown kind, an empty escape reason | — | M2 (accept an empty reason) → T1 red |
| T2 | `dispatch: impl` + no brief → refused, message names the `brief:` form | opted-in cwd, **valid Jev** | M1 (delete the brief branch) → T2 red |
| T3 | a review task whose **body** quotes `dispatch: impl` (inline and fenced) stays valid | opted-in cwd | M3 (scan the whole text) → T3 red |
| T4 | slug: `../x`, `a/b`, `none`, `A`, `""` refused; `consider-tax` accepted | — | M4 (accept any string) → T4 red |
| T5 | marker-only brief refused; Want+decision+marker accepted | briefs/ fixture | M5 (accept on marker alone) → T5 red |
| T6 | opted-in cwd whose tree lacks the brief → refused; manifest-less cwd → no check | two fixtures | M6 (skip when absent) → T6 red |
| T7 | integration: refusal reaches **zero spawns** with a *valid Jev* line, and the message is brief-specific; the signed-brief control **does** spawn | the existing `dispatch-line-enforcement` harness | M1 → T7 red; Jev alone cannot redden it |
| T8 | the escape `brief: none — <reason>` is valid **and** warns, on all four validating paths | opted-in cwd | M7 (drop the warning) → T8 red |

Filtered runs quote `node scripts/require-executed.mjs` (a `-t` filter matching nothing exits 0 — #591).

---

## Falsifiers

**(a)** With the header mandated (option A), **any** dispatch — auto-routed or preset'd — that omits `dispatch:`, or
declares `impl` without a signed brief, is refused **before spawn** (T2, T7; M1 reddens both). A signed brief spawns
(T7 control); a review dispatch stays valid (T3, P6).

**(b)** At the next real want, the conductor lists **every question it put to the human** and labels each *decision*
(legitimate) or *fact* (a defect). One fact-question fails the receipt — even with zero conductor reads and a fully
sourced Facts table; the zero-reads predicate is checked separately. Honest limit: a next-cycle receipt, not a result
this build produces.

---

## Cost, stated

- Every dispatch in this repo gains a 2–3 line leading block; forgetting it is a loud refusal, which is the point.
- The existing process-check fixtures (3 files / 83 tests) gain the header.
- No schema change, no new tool parameter, no new manifest key, no preset resolution, no batch plumbing.

## Filed, not fixed here

`noJev`'s guard (`COERCED_PRIMITIVE_RE` via `readNoJevReason`) accepts exponent-form numbers (`1e+21`, `1e-7`) through
the real `coerce: true` path, so a numeric bypass can pass as a stated reason. A shipped-code defect with its own fix
and test; r3 does not depend on that guard.

## Out of scope

Unit 2 (wiki index) · Unit 3 (vocabulary + the forbidden-synonym lint, including the worktree→runner persistence
hazard the upstream capture flags) · #599/#602/#603 and `scripts/dispatch.mjs` · `/grill` as a user command · a
round/question cap.

## Upstream (adapt, don't import)

`mattpocock/skills` @ `6f7f7831a625f040a8e06a0e7954826b87ce775a` (main, 2026-11-25), MIT © 2026 Matt Pocock. Primary
file `skills/productivity/grilling/SKILL.md` (blob `d2f09a18…`); verbatim capture in
`.development/investigations/issue-606-grilling-upstream-2026-11-27.md`. Persistence (`briefs/`), the refusal and
fact-provenance are Unit 1 **additions**, never inheritances.

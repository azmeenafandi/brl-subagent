# #450 — attach the background settle handlers before the prompt (shape (b)) — spec r6

**Issue:** #450 — hardening. Recorded priority **low** (2026-11-20: bounded consequence, zero observed
incidence) · classifier risk **C1** · `fix: mechanical` · worktree **y** · review **C2 focused**.
**Cycle:** `settle-handlers` (open 2026-11-20) — **U1**.
**Spec r6:** 2026-11-20, against `dev @ e9a5f55` (dispatched on the round-5 critique commit `f16fc44`;
HEAD at r6 completion is `e9a5f55`, the round-5 handoff commit). No source or test file has moved since
`481b852`: `git log --oneline 481b852..HEAD -- src/ package.json vitest.config.ts` → **0**, and
`git status --porcelain -- src/ package.json vitest.config.ts` → **0** lines (re-checked for r6; this
investigation file is the only path the r6 patch writes).
**Provenance:** r5 (this file, preserved at `9db78ec`) + the round-5 critique
(`issue-450-plan-critique-r5-2026-11-20.md`, **five findings — 3 major, 2 minor — all accepted**) + the
probes in §Evidence (E1–E49). **The r6 measurements were all taken on trees this r6 patch built itself**
from the repository, not carried from the r5 run: `/tmp/brl450-r6/intended` (the repository + the two
files, with the r6 contract comment), `/tmp/brl450-r6/base` (the repository, same corpus, no r6 files),
and `/tmp/brl450-r6-mut` (the mutant work tree). The r5 run was killed and resumed, so its `/tmp` state is
used **only as an artifact to inspect** (and one of those artifacts was found defective — the stored M18
patch, E46). Rounds 1–4 are verified resolved and are **not** regressed (§findings table rows 1–22
unchanged); the 21 mutants are re-run in ONE pass on the r6 tree by the self-contained gate (E46: 20 RED,
M18 GREEN). Locked decisions untouched: **S1** (accept `running` at the caller's resume), **G1′**
(closed-window ratchet — its *instrument* is strengthened, not its decision), **#542** (D8 residue out of
scope) and **#543** (the global log-sink fix, out of scope).

## r6 changes (r5 → r6)

Targeted patch: the round-5 critique's five findings — **3 major, 2 minor, all accepted** — and **no design
decision changes**. The r5 structure is kept; only the sections the findings touch move.

| # | r5 | r6 | Why (finding) |
|---|---|---|---|
| 1 | The species contract was stated three times in three different shapes — the site's "safe `constructor` lookup (the intrinsic `Promise`, or absent)", D3's "safe `constructor` lookup", Acceptance 8's "a native promise whose `constructor` read throws is out of contract" — and D2.3 also said "**any other value** throws synchronously", although a same-realm **subclass** and a **cross-realm** promise were measured **accepted** (exit 0). | **One** contract — **CONTRACT C450-R6** (D2.3) — used **word-for-word** at all three places: the REGIME 2 site comment (printed in D2.3, measured on the r6 tree), D3, and Acceptance 8. It covers `constructor` **and** `Symbol.species`, and splits **UNSUPPORTED** (no guarantee) into **necessarily rejected** (the intrinsic cannot attach) and **measured accepted, not relied on** (same-realm subclass, cross-realm promise). The residual and its falsifier are named; no accepted value is called rejected. (E44) | critique r5 #1 — with `p.constructor === Promise` and a throwing `Promise[Symbol.species]`, the routing printed `catch=Error: species getter exploded` and the host exited **1** in default **and** strict mode (E44): "safe `constructor`" did not cover the species read. `species-variants.mjs` routed the subclass and the cross-realm promise with exit 0. |
| 2 | The test delta was **over** the flow gate — net 909 against an allowance of 514 for 197 net source lines, i.e. **over by 395** — and neither the execution sketch nor the PR-body list mentioned the declaration the gate requires. | **G1′ is kept.** On the r6 tree the measured delta is source **+253/−35** (net **218** — the +21 over r5 is the contract comment itself) → allowance **556**; test **+910/−1** (net **909**) → **over by 353** (E43). The bare declaration `Test budget: over-allowance — …` is now a numbered step in the execution sketch **and** a line in the PR-body checklist, with a one-paragraph rationale; Q3 records why the indentation-normalised window snapshot/hash was rejected. | critique r5 #2 — `git diff --no-index --numstat` gave +232/−35 and +910/−1 on the r5 tree; `scripts/check-test-budget.mjs --flow` computes `allowance = 120 + 2 × max(Δsource, 0)`, and `--declaration` requires a line-start `Test budget: <reason>` outside fences (measured: the line exits 0, the same line inside a fence exits 1 — E43). |
| 3 | Appendix A was **not a gate**: it depended on absolute `/tmp` paths and 21 external `python3` patches, inlined only M19/M21, and printed the **expected** RED/GREEN label (`$want`) beside the observed line. | Appendix A is **one self-contained bash script**: 21 inline, single-occurrence search/replace patches, `BASE` supplied by the reader, and the verdict **derived** — `tsc --noEmit` exit 0 **and** the named selection exit 1 ⇒ RED; exit 0 ⇒ GREEN; `tsc` ≠ 0 ⇒ COMPILE-FAIL. Executed end-to-end on the r6 tree by the proposer (**E46**: 21/21 patches applied, **20 RED, M18 GREEN, `tsc=0` everywhere**) — which also exposed the **M18 correction**: the r5 stored `m18.py` wrote its output to *its own file*, so the source was never mutated and r5's "M18 GREEN" measured the unchanged tree. | critique r5 #3 — `rg '^# /tmp/brl450-r5-mutscripts/'` found only m19/m21 in the appendix; `mutants-final.sh` references all 21 external patches and prints `$want`. |
| 4 | "Sites 1–3 are pinned by T4 case 6", and (E42) "the two existing catch-all tests never reach those log lines". | A **measured reachability matrix** (E45, a file-write marker at each of the six `safeLog` sites): **site 2** is behaviourally pinned (T4 cases 5 and 6) and **site 6** by T3 cases 1 and 3; **sites 1 and 3 are construction-only** (0 hits); **site 4 IS reached** by two existing catch-all tests (1 hit each) though neither makes the sink throw, so its *containment* is unpinned; site 5 is 0. E42's `console.log` instrument was **blind**: this harness prints a *passing* test's console output nowhere (control in E45), so "marker printed 0 times" proved nothing. | critique r5 #4 — M18 GREEN means the teardown catch is unreachable through the harness, and the retire catch cannot fire at all; and r6's own instrument corrects E42 in the other direction as well. |
| 5 | E40 was listed as **carried**, with the explanation "their subjects are unchanged by r5 — … `safeLog`'s totality", although `safeLog` is **new in r5**. | E40's provenance is corrected: it is an **r5-era** entry measured on the r5 tree (`/tmp/brl450-r5fresh`), and the claim that its subject predates r5 is withdrawn — `git diff --no-index --numstat /tmp/brl450-r4/src/session-manager.ts /tmp/brl450-r5fresh/src/session-manager.ts` → **+48/−18**, with `grep -c "function safeLog"` **0 on r4, 1 on r5** (E48). The **fresh** run of the probe against the r6 tree is a separate statement (E48: `SAFELOG_TOTAL=yes`, 7/7). | critique r5 #5 — the carried-entry label cannot establish which tree the earlier run measured. |

The five fixes touch `D2.2`/`D2.3`/`D3`/`Q2`/Acceptance 8 (the one contract), `Q3`/`Delta budget`/the
execution sketch + the PR-body checklist (the declaration), `Appendix A`/`§Mutants` (the self-contained
gate), `D5.1`/`§Risks` (the reachability matrix) and `§Evidence` (E40's provenance, E43–E49). **No** locked
decision is reopened: the deferred, the attach-before-call ordering, the two-regime split, the
no-settle-in-the-pre-start-catch rule (D6), the intrinsic routing (R1′), the status decision (S1), the
closed-window ratchet (G1′) and the #542/#543 boundaries all stand.

## r5 changes (r4 → r5)

Targeted patch: five findings, five regions — **no design decision changes**. The r4 structure is kept;
the sections below are the ones the findings touch.

| # | r4 | r5 | Why (finding) |
|---|---|---|---|
| 1 | The two **regime bodies** were pinned by a regex over the **raw** window text (`/try \{\n {4}void Promise\.prototype\.then\.call…/`). A **comment** anywhere in the window that spelled that text satisfied the pin. | Both regime bodies are pinned by the **same comment/string/regex-masked, brace-matched** extraction the handler bodies already used: `regimeBodyLines(windowSrc, "<the one statement>")` locates the statement in masked text, requires the enclosing `try {` body to **OPEN on it**, and asserts the body is **exactly** that one statement. **M19** (the critic's comment decoy **plus** a real throw) and **M21** (the same text in a template literal) are named mutants and are **red** (T1); both are **green** on the r4 tree, which is the finding. (Q3, T1, Acceptance 2) | critique r4 #1 — the critic placed the exact regime-2 `try` text in a marker-helper *comment* and inserted a real throw before the routing: `tsc` 0 and the ratchet **passed** (`/tmp/brl450-r4crit-regime`, re-measured as E33) |
| 2 | D2.3/D3/Acceptance 8 claimed intrinsic routing "cannot throw" for **every** native promise. | The contract is **narrowed** to an **ordinary native `Promise<void>` whose `constructor` lookup is safe**, the residual is named at the site and in D3/Acceptance 8, and the species probe is a falsifier (E32) — its named row is **C2** in §Mutants (a contract falsifier, not a source mutant: no in-process test can assert a deliberate host exit), with **M20** as the containment attempt. One line says why no containment exists: every attach path performs the same `constructor` read. | critique r4 #2 — `Promise.prototype.then` performs a `SpeciesConstructor` read; a native promise with a throwing `constructor` getter strands a later rejection and the host exits **1**, under `--unhandled-rejections=strict` **and** in the default mode (E32) |
| 3 | Catch-path log calls were plain `log.warn`/`log.error`; `src/logging.ts:158–160` calls the console mirror **outside** its file-write catch. | Every **catch-path** log call in this unit goes through a new module-level **`safeLog(write: () => void)`** that swallows a logger fault. Falsifier: **T4 case 6** — `setConsoleOutput(true)` + a throwing `console.warn` must keep the original error **and** still attempt the retire (E35). The global fix is filed as **#543** and is out of scope; the local containment is still required. | critique r4 #3 — T4 case 5 with a throwing console received `console blew up` instead of `original prompt` (E35, pre-fix) |
| 4 | The masker's stated blind spot was "a regex literal *inside* the settle bodies". | The masker **classifies regex literals** (standard predecessor heuristic) and **fails closed**: a `/` it calls a regex that does not close on its line throws, and the brace match is verified against a **construct boundary** so a `}` inside a regex can no longer truncate a body silently. The critic's two reproductions plus the fail-closed cases are a new named test (**T7**, 14 rows), measured (E34). | critique r4 #4 — `/[/*]/` before a declaration → "declaration not found"; `/[}]/` inside → the body came back truncated as `const r = /[` (E34) |
| 5 | E10/E26/E29 cited `/tmp/brl450-r4-probes/mutants5.sh`, whose M4–M7 patch called an **undefined** `maybeThrowFromFutureEdit()` (`tsc=1`), and the suite counts read "70 failed / 10 failed files". | The **compiling** script is the one preserved verbatim in §Appendix (`/tmp/brl450-r5-probes/mutants-final.sh`), the mutant table states each compiling statement, and the counts are corrected to **69 failed / 1 skipped / 10 failed files / 31 failed suites** on the `/tmp` corpus — plus the same-corpus full-suite comparison (**added names: ∅**) — compared **by normalized name**, never by arithmetic. E38 runs all **21** mutants in one pass on the r5 tree with `tsc=0` throughout. | critique r4 #5 — the saved script gave M4–M7 `tsc=1`; the JSON says 69 failed + 1 skipped, not 70 failed (E36/E37) |

The five fixes touch `Q3`/`T1`/`T7` (the instrument), `D2.2`/`D2.3`/`D3`/`Q2`/Acceptance 8 (the species
contract), `D1`/`D2`/`D5`/T4 case 6 (catch-path logging), `Ratchet limits` (fail-closed lexing), and the
evidence/count hygiene (§Evidence, §Mutants, §Delta, execution sketch). **No** locked decision is reopened:
the deferred, the attach-before-call ordering, the two-regime split, the no-settle-in-the-pre-start-catch
rule (D6), the intrinsic routing (R1′), the status decision (S1) and the closed-window ratchet (G1′) all
stand.

> **r6 supersedes three r5 statements.** (1) Row 2's contract wording — "safe `constructor` lookup" plus
> "any other value throws" — is replaced by **CONTRACT C450-R6** (D2.3), which also covers
> `Symbol.species`, distinguishes *unsupported* from *necessarily rejected*, and stops calling the
> measured-accepted subclass/cross-realm values rejected (r5 critique #1, E44). (2) Row 5's claim that
> `/tmp/brl450-r5-probes/mutants-final.sh` is "the one the table cites" is superseded by §Appendix A,
> which is self-contained (r5 critique #3, E46) — and the r5 stored M18 patch it relied on was a no-op
> (E46). (3) The r5 D5.1 sentence "sites 1–3 are pinned by T4 case 6" and E42's "the catch-all tests never
> reach those lines" are replaced by the measured reachability matrix (E45). The rest of the r5 table
> stands.

## r4 changes (r3 → r4) — history, carried verbatim

Targeted patch: three findings, three regions. Everything else in r3 is carried over verbatim. (r5 does not
change any row here; its own table is above. Two r4 statements are superseded by r5 and are corrected where
they appear: the "cannot throw for every native promise" claim in D2.3/D3/Acceptance 8, and the suite
labels in E10/E26/E29.)

| # | r3 | r4 | Why (finding) |
|---|---|---|---|
| 1 | The body-entry tripwire is the **`clearTimeout` count** (green = 1), and T1 pins each settle body's head with two **unanchored regexes** over the window text (`/const onSettleFault = …\n {4}if \(deadlineHandle\) clearTimeout…/`). | The body-entry observable is **`markSettleEntry(kind)`**, the **first executable statement** of each body, emitting **one `log.debug` record** that does not read `deadlineHandle` at all. **T5 asserts ZERO entry records** on the sync-throw path (alongside the transcript/event checks and `messages: []`), plus a **positive control** in the same test that makes the instrument fire once. **T1** locates each declaration in a **comment/string-masked** copy of the source and **brace-matches** from `{` to the body's `}`, then asserts `[0]` is the marker and `[1]` is the deadline clear. (D1, D6, T1, T5) | critique r3 #1 — the critic's `/tmp/brl450-critic-conditional` (handle unset + `rejectSettled(err)` after cleanup, body dies on its first line) **passed T1 and T5** with `tsc` exit 0, and a block-comment decoy did too (E26 re-measures both as **M14/M15, red**) |
| 2 | "There is **no behavioural mutant** that kills only the containment (all teardown throw sites the harness can reach are now total)" — stated of the whole of `failPreStart`. | The limit is **narrowed to the teardown catch**, and the other two steps get mutants: **T4 case 5** makes the **third `appendEntry`** throw (the terminal write itself) and asserts the original throw still reaches the caller (**M16**) and that the registry retire was **attempted** (`clearInflightRun` spy, end-state check) (**M17**). (D5, T4, Risks) | critique r3 #2 — with containment the original-error assertion passes; removing only the `finalizeRunEntry` catch yields `append blew up` instead of `original prompt` (E26/M16) |
| 3 | D2.1 scopes the never-issued proof **in the spec prose**, but the r3 scratch **site comment** still said a synchronous throw "therefore means the callee was never entered" unqualified, and Acceptance 3 stated the pre-start claim without the scope. | The **three preconditions are pasted into the code**: the REGIME 1 comment (exact text in D2.1) and `failPreStart`'s doc comment. **Acceptance 3 is qualified** ("pre-start *under D2.1*"), and the wrapper probe (`live=true`, E24) is named as the falsifier that must not be described as proven pre-start. (D2.1, Acceptance 3, execution sketch) | critique r3 #3 — `read /tmp/brl450-r3/src/session-manager.ts` showed the unqualified sentence; `node …/start-then-throw.mjs` reports `live=true` (E24) |

The three fixes touch `D1` (the marker), `D2.1` (the site comment), `D5` (the honest limit), `D6`/`T5`
(the tripwire), `Q3`/`T1` (the pin), and also `Acceptance`, `Tests`, `Mutants`, `Risks`, `Delta`, the
execution sketch and the design assumptions. **No** locked decision is reopened: the deferred, the
attach-before-call ordering, the two-regime split, the no-settle-in-the-pre-start-catch rule (D6), the
intrinsic routing (R1′), the status decision (S1) and the closed-window ratchet (G1′) all stand.

## Context (verified 2026-11-20)

| Anchor | Line (baseline) | What it is |
|---|---|---|
| `agent._sessionRef = session;` | `:1988` | the live-session ref (D8 roots) |
| `deadlineHandle = armDeadline(...)` | `:2462` | the one deadline owner (#453), armed **before** the prompt |
| `run.acceptedAt = new Date().toISOString()` | `:2472` | the durable acceptance marker (#447) |
| `persistRunRecord(pi, run, "background")` | `:2474` | the acceptance write (throw → `failPreStart` → rethrow) |
| `runPromise = session.prompt(wrapTask(params.task))` | `:2490` | the one call whose return must be monitored — the only `prompt(` **call** in `src/` (E3 coverage: 9 hits, 8 comments + this call) |
| `runPromise.then(() => {` | `:2501` | the settle handlers, attached **after** the call returns (the defect) |
| `}).catch((err: Error) => {` | `:2651` | the rejection settle |
| `const failPreStart = (message: string)` | `:1942` | deadline clear → branch teardown → entry finalize → registry retire |
| `const markTerminalBestEffort` | `:2283` | the settle-handler catch-all |
| `agents.set(id, agent);` | `:1576` | the pre-prompt record write (the pre-start retention root) |
| `gitCleanupDone` guard in `cleanupWorkBranch` | `:1841` | once-per-run teardown |
| `armDeadline`'s timer body | `:2350–2440` | `if (agent.completedAt) return`, abort, `prune: false` snapshot |
| `clearTimeout(deadlineHandle)` | `:1943`, `:2502`, `:2652` | the **only three call sites** in the file — re-measured on the r4 tree: `grep -n "clearTimeout(" src/session-manager.ts` → `:1985`, `:2588`, `:2741` (3 hits; `grep -c clearTimeout` → **4** lines, the fourth being the marker's own comment) |
| **NEW r4:** `const markSettleEntry = (kind: …): void => {` | r4 `:2578` | the settle bodies' first statement — the body-entry record (D6/T5) |

Line numbers are the **baseline's**. The r4 implementation adds lines above the window (`normalizeThrown`
at `:108`, the contained `failPreStart` at `:1977`, the marker at `:2578` — both re-measured on the r4 tree),
so the implementer must re-derive every anchor with the step-1 grep rather than trust these numbers
(execution sketch, step 1).


  > **r6 note on the anchors.** The line numbers in the table above are the **baseline's**. The implementation
> adds lines above the window (`normalizeThrown`/`thrownMessage` at `:108`, **`safeLog` at `:137`**, the
> contained `failPreStart` at **`:1995`**, the marker at **`:2602`**), so the implementer must re-derive every
> anchor with the step-1 grep rather than trust these numbers (execution sketch, step 1).
> Measured on the **r6** tree (`/tmp/brl450-r6/intended`, E47): `grep -n "clearTimeout(" src/session-manager.ts`
> → `:2003`, `:2612`, `:2767` (3 call sites); `grep -n "markSettleEntry" src/session-manager.ts` → 3 hits
> (`:2602` declaration, `:2611` success, `:2766` fault); `grep -n "const failPreStart = "` → `:1995`;
> `grep -n "function safeLog"` → `:137`. The r6 contract comment sits **inside** the REGIME 2 comment block
> (its last line is the routing's `try`), above the routing at `:2927`, so it moves no anchor that the
> table cites — the r5 and r6 numbers are identical for every anchor above, which is why the comment could
> be added without touching the instrument.

## The defect, restated precisely

Two failure classes sit in a 9-line span (`:2482–:2503`), not one:

1. **A throwing statement between `prompt()` returning and `.then` attaching.** The settle is lost; the
   pre-armed deadline (#453) replaces the outcome with a `timeout` classification, `cleanupWorkBranch`
   never runs, and the work-branch lock plus the session dir are held until process exit. Only a code
   edit can introduce it.
2. **A throw *after* the routing attach but inside the same `try`** (r1's own shape, critique r1 #2). The
   throw reaches `failPreStart`, which declares "the prompt was never issued" and prunes a **live**
   session's directory and releases its branch lock while the session may still be writing — strictly
   worse than the class it was meant to prevent.

Class 2 is a defect r1 *introduced*. That is why r2 splits the region instead of widening the `try`.

**Why the issue is still C1/low (claim narrowed in r3, and now pinned in the code — r4 finding #3).** 591/591
background spawns settled, 0 background timeouts. With the real SDK — `prompt` is `async` (E3) and is
called **unwrapped** at the one call site (E3 coverage) — a synchronous throw means the callee was never
entered, **under the three D2.1 preconditions**. This spec closes class 1 structurally, removes class 2,
pins both, and closes the routing fault the round-2 critique found in r2's regime 2.

## Design

### D1 — The deferred, and THE ATTACH, before the call (shape (b)) — unchanged in shape; the marker is new (r4), the catch-path logs are contained (r5)

Created **after** the acceptance write (a failed acceptance must not leave an unowned promise), the two
settle handlers go on **our own** promise, and the attach is one named statement **above** the prompt
call. The handler bodies are textually unchanged — they keep their indentation and their `.then`/`.catch`
topology (`a throw inside the success body` is still contained by its own `try/catch`; a genuine prompt
rejection still reaches the fault body) — **plus one new first statement in each body** (r4).

```ts
  let runPromise: Promise<unknown>;
  let resolveSettled!: () => void;
  let rejectSettled!: (reason: unknown) => void;
  const settled = new Promise<void>((resolve, reject) => {
    resolveSettled = resolve;
    rejectSettled = reject;
  });

  // >>> r4: the body-entry marker — PASTE VERBATIM (D6/T5, finding #1) <<<
  const markSettleEntry = (kind: 'success' | 'fault'): void => {
    try {
      log.debug(`spawnBackgroundSession: settle body entered for ${id} (${kind})`);
    } catch {
      // best effort — the marker must never change the settle path
    }
  };

  const onSettled = (): void => {
    markSettleEntry('success');                         // D6/T5: the FIRST statement
    if (deadlineHandle) clearTimeout(deadlineHandle);   // D7 + the SECOND entry signal
    try {
      /* — the existing :2502 body, unchanged — */
    } catch (err) { /* existing catch-all: safeLog(...) + thrownMessage (D5/r5) */ }
  };

  const onSettleFault = (reason: unknown): void => {
    markSettleEntry('fault');                           // D6/T5: the FIRST statement
    if (deadlineHandle) clearTimeout(deadlineHandle);   // D7 + the SECOND entry signal
    try {
      const err = normalizeThrown(reason);              // D5: TOTAL, never throws
      /* — the existing :2651 body, unchanged except the `err` binding — */
    } catch (err) { /* existing catch-all: safeLog(...) + thrownMessage (D5/r5) */ }
  };

  // THE ATTACH
  settled.then(onSettled).catch(onSettleFault);
```

**The marker's contract, spelled out so nothing is invented at the keyboard** (r4, finding #1):

| Aspect | Value |
|---|---|
| name | `markSettleEntry` — an arrow declared **inside `spawnBackgroundSession`**, immediately above `const onSettled` (it closes over `id`, so a module-level function would need the id passed and a second call-site decision) |
| signature | `(kind: 'success' \| 'fault'): void` |
| level | **`debug`** |
| message | `` `spawnBackgroundSession: settle body entered for ${id} (${kind})` `` — no `data` object, so the record's `JSON.stringify` cannot touch a caller value |
| position | the **first executable statement** of both bodies, **above** the `clearTimeout` and above the `try` |
| containment | the helper has its own `try/catch`; `consoleOutput` is off unless `BRL_LOG_CONSOLE` says otherwise. **Corrected r5:** `logging.ts` wraps the **file write** only — its console mirror is *outside* that catch (D5.1), so the helper's own `try/catch` is load-bearing, not decorative, exactly as for the catch-path calls |
| neutrality | `minLevel` defaults to `"info"`, so **nothing is written in production** (measured, E25: 0 bytes with the default level) |

Why a `debug` record and not a counter: it is the cheapest **behaviour-neutral** record (`logging.ts`
already contains the write in `try/catch`, and the level filter keeps it off by default), it is an
existing repo pattern (`grep -rn "log\.debug(" src/*.ts` → 6 hits, 5 of them call sites in
`mode-runners.ts`, `scratch-spawn.ts`, `unit-run.ts` ×2 and this one; the sixth is the #235 comment), and
it needs **no state**, so it cannot leak or drift. Its observability is a **test-side** decision: T5 raises
the level to `debug` and points the sink at the test's temp cwd (fixture requirement, §Tests).

Why the two handlers are named rather than `.then(() => { … })`: it keeps the ~150-line bodies at their
current indentation (a wrapper would re-indent every line and produce a whitespace-only 300-line diff) and
reduces the invariant to one checkable statement — *the attach line exists, and it is above the call*.
**Both bodies now ENTER on the marker**, which r4 makes load-bearing: it is T5's body-entry observable and
is pinned by T1 (§Tests).

**Chosen over shape (a)** (`Promise.resolve().then(() => session.prompt(…))`), which empties the window but
changes spawn-queue interleaving (`resolveNext()` would run before the prompt), loses the synchronous
acceptance and turns a pre-start rejection into an async terminal event. Decision already recorded on the
issue; not reopened.

**r5 addendum — the bodies' catch-alls log through `safeLog` (finding #3).** The two `catch (err)` blocks
above are the settle **catch-all** paths (`markTerminalBestEffort` follows the log line). Their log call is
`safeLog(() => log.error(...))`, not `log.error(...)`, so a throwing sink cannot skip `markTerminalBestEffort`
— see D5.1 for the helper and T4 case 6 for the measured falsifier. Nothing else in D1 changes: the marker
still has its own `try/catch`, and the bodies' text is otherwise byte-identical.

### D2 — The catch boundary: two regimes, separated by syntax, not a flag (critique r1 #2; narrowed by r2 #1; catch-path log contained r5 #3)

`failPreStart` is only *true* when nothing started. The boundary is therefore the prompt **call**, and the
code says so with two adjacent `try` statements:

```ts
  // ---- REGIME 1: pre-start ------------------------------------------------
  try {
    runPromise = session.prompt(wrapTask(params.task));
  } catch (err) {
    const reason = thrownMessage(err);                          // D5: total
    failPreStart(sanitizeErrorMessage(reason, effectiveCwd));    // D5: contained, never throws
    throw err;                                                  // D6: deferred NOT settled
  }

  // ---- REGIME 2: post-start ----------------------------------------------
  try {
    void Promise.prototype.then.call(runPromise, resolveSettled, rejectSettled);   // D2.3
  } catch (err) {
    safeLog(() =>                                                // ← r5: a sensor, not a new fault
      log.error(
        `spawnBackgroundSession: settle routing failed for ${id} — the run is unmonitored; its deadline remains the only bound`,
        { error: thrownMessage(err) },
      ),
    );
  }
```

**r5: why the regime-2 catch logs through `safeLog` (finding #3).** This `log.error` is *itself* in a catch
block, and it is the last statement before `return agent;`. With `setConsoleOutput(true)` and a throwing
`console.error`, the plain call would throw out of the catch and **reject the spawn** — converting an
out-of-contract routing fault (spawn resolves, run left to the deadline) into a rejected spawn (the #439
boundary broken). `safeLog` is what keeps D2.2's "does not reject the spawn" true when the log sink is the
second fault. T3's case 1 asserts the log line, so the containment cannot silently swallow the record when
the sink is healthy.

#### D2.1 — What "provably never issued" proves, and what it does not (critique r2 #1; **now carried into the code**, critique r3 #3)

The claim r2 made was too wide. r3 states it as a **contract on the call shape**:

> **D2.1 (never-issued proof).** A synchronous throw out of
> `runPromise = session.prompt(wrapTask(params.task))` is proof that the prompt was never issued **iff**
> (a) the callee is the SDK's own `async` method `AgentSession.prompt`
> (`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1704`, typed
> `prompt(text): Promise<void>`, `agent-session.d.ts:573`), (b) it is reached by a plain property read on
> the session object (no getter/Proxy in between), and (c) the argument is evaluated without side effects
> (`wrapTask` is one `String.replace`, `src/prompt.ts:67`).

Each clause is load-bearing:

- **(a) `async`.** An `async` function cannot throw to its caller; a throw inside it becomes a rejection.
  So a synchronous throw can only have happened *before* entry.
- **(b) plain read.** A **getter** can start the real method and then throw — the caller sees a synchronous
  throw while the session is already running. The probe does exactly this and prints `live: true`
  (E24: `syncThrow=yes`, `live=true`, `settledLate=resolved`). *That shape is outside the contract*: it
  must not be claimed as proven pre-start.
- **(c) pure argument.** If argument evaluation could start work, the same hole reopens. It cannot today
  (E14: `wrapTask` is `task.replace(/<\/?task>/g, …)`).

**The proof now lives at the site, not only in this spec (r4, finding #3).** The implementer pastes
**exactly** this comment above `// ---- REGIME 1`:

```ts
  // ---- REGIME 1: pre-start ------------------------------------------------
  // The one statement in this regime is the prompt CALL. A synchronous throw
  // from it is proof that the prompt was never issued ONLY under three
  // preconditions, and all three hold at this site TODAY (issue #450 D2.1):
  //
  //   (a) the callee is the SDK's own `async` method — `AgentSession.prompt`
  //       (node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1704,
  //       typed `prompt(text): Promise<void>` in agent-session.d.ts:573). An
  //       `async` function cannot throw to its caller: such a throw happened
  //       BEFORE entry.
  //   (b) it is reached by a PLAIN property read on the session object — no
  //       getter, no Proxy. A getter can start the real method and THEN throw,
  //       so the caller sees a synchronous throw while the session is already
  //       running (spec E24: `syncThrow=yes`, `live=true`). That shape VOIDS
  //       the proof and must be handled as a post-start fault.
  //   (c) the argument is evaluated without side effects (`wrapTask` is one
  //       `String.replace`, src/prompt.ts:67).
  //
  // If a future edit wraps `session.prompt` — a retry wrapper, a decorator, an
  // injected session double that starts work — then (a)/(b) no longer hold,
  // this regime's premise is GONE, and `failPreStart`'s directory prune plus
  // branch release would hit a LIVE session. Re-derive D2.1 before keeping it.
```

and this addition to `failPreStart`'s doc comment, directly under its "PRUNING IS PROVABLY SAFE HERE —
and only here" paragraph:

```ts
   * "Never issued" is a CONTRACT, not an observation — issue #450 D2.1: it
   * holds because the call site invokes (a) the SDK's own `async` `prompt`
   * through (b) a plain property read, with (c) a side-effect-free argument.
   * A wrapper/getter that starts the real method and then throws breaks all of
   * that (spec E24: `live=true` after the synchronous throw); such a call shape
   * must NOT reach this function. See the REGIME 1 comment at the call site.
```

**Consequence for the code.** Regime 1's catch still calls `failPreStart` — the *only* site where pruning
is safe — but the justification is the contract above, and it is written at the site as such. A future
edit that wraps `session.prompt` (a retry wrapper, a decorator, an injected session double that starts
work) **voids** the proof; it must be treated as a post-start fault (regime-2 semantics), not silently
absorbed.

**Falsifier (used, E24):** a wrapper that starts `prompt` and then throws. If a wrapper ever enters this
call site, D2.1 must be re-derived *before* `failPreStart` is kept. The probe is in §Evidence (E24); the
corresponding §Mutants row (**C1**) is deliberately **not** a source mutant — it changes the *contract*,
not the code, and the test suite cannot see it. **The wrapper shape must never be described as "proven
pre-start"** — that sentence is the finding, and it is now unreachable from the code comments.

#### D2.2 — What regime 2 does and does not do

- Does **not** call `failPreStart`: no never-issued message, no dir prune, no branch release while the
  session may write.
- Does **not** clear the deadline and does **not** arm a second bound: ADR 0023 decision 1 keeps one
  owner. The already-armed deadline is the monitor of last resort — it aborts, then writes the
  `timeout`/`aborted` snapshot with `prune: false`, so a still-writing session keeps its dir and its
  branch.
- Does **not** reject the spawn: the run started; the caller must not receive
  "Failed to spawn background agent" (the #439 boundary). The spawn resolves with the agent, `running`.
- **Is unreachable only for the SUPPORTED value, as CONTRACT C450-R6 (D2.3) defines it** (r6): an
  ordinary native `Promise<void>` of this realm whose `constructor` **and** `Symbol.species` reads both
  complete without a throw and resolve to the intrinsic `Promise`. For that value the routing is
  `Promise.prototype.then` itself (E22: `p.then === Promise.prototype.then` → `true`) and the species step
  yields the intrinsic, so nothing after the receiver check can throw. Every other value is
  **unsupported**: either **necessarily rejected** (the intrinsic cannot attach — the routing throws and
  the catch logs) or **measured accepted but not relied on** (a same-realm subclass, a cross-realm
  promise — E44). The promise-shaped members of the rejected class are the residual.

#### D2.3 — The routing fault: one supported value and the named unsupported classes (critique r2 #2; contract re-stated and completed r6 #1)

r2's regime 2 was "log and continue" and called the deadline "the only bound". The critique showed that is
not a bound **for the process**: if no rejection handler is ever attached, a later rejection of that native
promise is an *unhandled rejection*, which terminates `node` — under `--unhandled-rejections=strict`
**and under the default mode** (E16: both exits are `1`; the default mode's `throw` behaviour is enough, so
the residual is not a flag-only curiosity).

r4 routes through the intrinsic; **r5 corrected *why* that is not enough, and r6 completes the correction.**
`PerformPromiseThen` is not a property lookup: it performs `SpeciesConstructor(promise)`, which reads
`promise.constructor` **and then** `constructor[Symbol.species]` (E32 for the first read, **E44 for the
second**). r5 said "a safe `constructor` lookup (the intrinsic `Promise`, or absent)" — and E44 shows a
promise whose `constructor` **is** the intrinsic `Promise` still throws when `Promise[Symbol.species]` is a
throwing getter: `p.constructor === Promise` → `true`, `routed=false`, `catch=Error: species getter
exploded`, exit **1** in the default mode and under `--unhandled-rejections=strict`. r5 also said that
"**any other value** throws synchronously at the routing", which called two measured-**accepted** values
rejected (E44: a same-realm `Promise` subclass and a cross-realm native promise both route and exit `0`).
Both defects are fixed by the one block below, and by nothing else.

**CONTRACT C450-R6 — this is the whole narrowing. The same sentences appear at the site (the REGIME 2
comment, printed below), in D3, and in Acceptance 8 — formatting differs (comment markers, line wrapping),
no word does.**

> SUPPORTED — an ordinary native `Promise<void>` of this realm whose `constructor` and `Symbol.species`
> reads BOTH complete without a throw and resolve to the intrinsic `Promise` (the species step reads both:
> SpeciesConstructor is `promise.constructor[Symbol.species]`).
>
> UNSUPPORTED — every other value: NO GUARANTEE. Measured, it splits in two.
>
> (i) NECESSARILY REJECTED, the intrinsic cannot attach: a non-thenable, a custom thenable, or a Proxy
> around a promise (TypeError at the receiver check); and a promise whose species resolution throws — an
> own `constructor` getter, a non-object `constructor`, or a throwing `Symbol.species` on the constructor.
> These throw HERE, synchronously, before any handler exists; the run is left to the deadline.
>
> (ii) MEASURED ACCEPTED, not relied on: a same-realm `Promise` subclass instance and a cross-realm native
> promise both route and deliver (probe species-contract.mjs, variants `subclass`/`cross-realm`, exit 0).
> Neither is producible by this realm's `async` method.
>
> THE RESIDUAL: class (i)'s promise-shaped members — a Proxy over a promise, and a species-throwing native
> promise — carry a rejection that no handler owns, so the host's unhandled-rejection policy applies and
> node exits 1 (default and strict; probe `species-contract.mjs`, variant `intrinsic-species-throws`:
> constructor === Promise, species read throws). No containment exists here: every attach path performs
> the same species read (Promise.resolve, Promise.race and `await` all do).

**Three-place identity, checked (E49).** Normalise each of the three texts by stripping the `//` and `>`
markers and collapsing whitespace: the site block printed below, D3's quote and Acceptance 8's quote are
the same 1492-character string, and it equals the comment actually present in the r6 tree.

**What each value class does** (all measured — E16/E22/E32/**E44**):

| Returned value | `.then`-by-property (r2) | intrinsic routing (r3–r6) |
|---|---|---|
| **ordinary** native `Promise<void>`, safe `constructor` **and** safe `Symbol.species` — the SUPPORTED value; what `async` returns | same function, handler attaches | identical: `p.then === Promise.prototype.then`, **no extra microtask** (E22: both reactions run in the same tick); `SpeciesConstructor` yields the intrinsic |
| native promise with an **own `then` accessor that throws** (the critic's reproduction) | lookup throws → **no handler** → later rejection kills the host (exit 1) | the `then` accessor is **never read**; the handler attaches; the rejection is delivered, process **survives** (exit 0) |
| a same-realm **`Promise` subclass** instance | override called (or throws) | the internal slot is used; attains correctly — **in the measured-accepted class, not relied on** (E44: `routed=true`, exit 0) |
| **cross-realm** native promise | same function, handler attaches | attains — **measured accepted, not relied on** (E44: `routed=true`, exit 0); not producible by this realm's `async` method |
| non-thenable (`{}`, `42`, `undefined`) | `TypeError` → caught → logged | `TypeError` at the receiver check → caught → logged (**necessarily rejected**; T3: spawn resolves, run stays `running`, the deadline classifies `timeout`; there is no promise, so nothing is stranded — exit 0) |
| non-native thenable (custom `then`) | the value's `then` is called (handled **by accident**) | `TypeError` → caught → logged: **necessarily rejected**, fails closed to the deadline |
| `Proxy` wrapping a native promise | the proxy's `then` (if not trapped) may attach | `TypeError: Method Promise.prototype.then called on incompatible receiver` → caught → logged; the **underlying rejection stays unowned** → **process residual** (exit 1, measured) |
| native promise with a **`constructor` getter that throws** (or a non-object `constructor`) | same species read → lookup throws → no handler → host exits **1** | **still exits 1**: the species read throws **before** the reaction is queued, `routed=false` (E32) — necessarily rejected, and promise-shaped, so its rejection is the residual too |
| a `constructor` that **is the intrinsic `Promise`** while **`Promise[Symbol.species]` throws** | same species read → throws → no handler → host exits **1** | **still exits 1** (E44): `p.constructor === Promise` → `true`, `routed=false`, `catch=Error: species getter exploded` — this is the row r5's "safe `constructor`" wording missed |

**Why no containment exists for the species residual (measured, not argued).** E44 runs four attach paths
against a throwing `Symbol.species` on the intrinsic, under both policies: `Promise.prototype.then.call(p,
…)`, `Promise.resolve(p).then(…)` and `Promise.race([p]).then(…)` all throw `Error: species getter
exploded`, and `await p` registers a continuation yet the process still exits **1**. There is nothing to
wrap the value in that would make the reaction attach.

**Why not contain the `Proxy` case either:** any containment would have to *own* the value, i.e. route
through `Promise.resolve(runPromise)`/`Promise.race([runPromise])`. Both **assimilate thenables**, which
changes the non-thenable contract that T3 exists to pin: `Promise.resolve({})` **resolves**, so a
non-thenable return would run the *success* body and record a live run as `completed` — a mis-report
strictly worse than the log. Measured as **M20** (E46: T3 red at `expected '' to contain 'settle routing
failed'`), and it buys nothing for the species case (E44). Rejected on that evidence (Q2, row R3).

**The site text (r6) — paste verbatim; it is the block D3 and Acceptance 8 carry, and it is the text the
r6 gate was run against (E46/E47):**

```ts
  // Issue #450 (D2.3/D3 — THE SUPPORTED-VALUE CONTRACT; these are the same words
  // as D3 and Acceptance 8, and they are the whole narrowing):
  //
  //   SUPPORTED — an ordinary native `Promise<void>` of this realm whose
  //   `constructor` and `Symbol.species` reads BOTH complete without a throw and
  //   resolve to the intrinsic `Promise` (the species step reads both:
  //   SpeciesConstructor is `promise.constructor[Symbol.species]`).
  //
  //   UNSUPPORTED — every other value: NO GUARANTEE. Measured, it splits in two.
  //   (i) NECESSARILY REJECTED, the intrinsic cannot attach: a non-thenable, a
  //   custom thenable, or a Proxy around a promise (TypeError at the receiver
  //   check); and a promise whose species resolution throws — an own
  //   `constructor` getter, a non-object `constructor`, or a throwing
  //   `Symbol.species` on the constructor. These throw HERE, synchronously,
  //   before any handler exists; the run is left to the deadline.
  //   (ii) MEASURED ACCEPTED, not relied on: a same-realm `Promise` subclass
  //   instance and a cross-realm native promise both route and deliver (probe
  //   species-contract.mjs, variants `subclass`/`cross-realm`, exit 0). Neither
  //   is producible by this realm's `async` method.
  //
  //   THE RESIDUAL: class (i)'s promise-shaped members — a Proxy over a promise,
  //   and a species-throwing native promise — carry a rejection that no handler
  //   owns, so the host's unhandled-rejection policy applies and node exits 1
  //   (default and strict; probe `species-contract.mjs`, variant
  //   `intrinsic-species-throws`: constructor === Promise, species read throws).
  //   No containment exists here: every attach path performs the same species
  //   read (Promise.resolve, Promise.race and `await` all do).
```

It **replaces** r5's two paragraphs ("The supported value is a native `Promise<void>` …" and "A value the
intrinsic refuses …"); the paragraph above them — why the routing is the intrinsic and not
`runPromise.then` — is unchanged. Measured with this text in place on the r6 tree: `tsc --noEmit` exit
**0**, **179/179** in the two files, full suite set-identical on the same corpus (E47).

**Falsifier (used, E16):** a `then` lookup that throws followed by a rejection must not take the process
down for a *supported* value — the probe shows exit `0` after the fix and exit `1` before it.
**Falsifier (used, E32):** a native promise with a throwing `constructor` getter exits **1** with or
without any containment attempt. **New r6 falsifier (used, E44):** a promise whose `constructor` **is** the
intrinsic `Promise` while its `Symbol.species` throws exits **1** — if a future edit starts claiming that
value is supported, this probe is the contradiction; if a future edit re-spells the routing as
`runPromise.then(…)`, T3's tampered case goes red (M13, measured).

### D3 — The return contract: the same one supported value, and the named unsupported classes (critique r1 #1, r2 #2; re-stated r6 #1)

**Contract — CONTRACT C450-R6, identical to D2.3 and to the site comment, and repeated in Acceptance 8:**

> SUPPORTED — an ordinary native `Promise<void>` of this realm whose `constructor` and `Symbol.species`
> reads BOTH complete without a throw and resolve to the intrinsic `Promise` (the species step reads both:
> SpeciesConstructor is `promise.constructor[Symbol.species]`).
>
> UNSUPPORTED — every other value: NO GUARANTEE. Measured, it splits in two.
>
> (i) NECESSARILY REJECTED, the intrinsic cannot attach: a non-thenable, a custom thenable, or a Proxy
> around a promise (TypeError at the receiver check); and a promise whose species resolution throws — an
> own `constructor` getter, a non-object `constructor`, or a throwing `Symbol.species` on the constructor.
> These throw HERE, synchronously, before any handler exists; the run is left to the deadline.
>
> (ii) MEASURED ACCEPTED, not relied on: a same-realm `Promise` subclass instance and a cross-realm native
> promise both route and deliver (probe species-contract.mjs, variants `subclass`/`cross-realm`, exit 0).
> Neither is producible by this realm's `async` method.
>
> THE RESIDUAL: class (i)'s promise-shaped members — a Proxy over a promise, and a species-throwing native
> promise — carry a rejection that no handler owns, so the host's unhandled-rejection policy applies and
> node exits 1 (default and strict; probe `species-contract.mjs`, variant `intrinsic-species-throws`:
> constructor === Promise, species read throws). No containment exists here: every attach path performs
> the same species read (Promise.resolve, Promise.race and `await` all do).

What the design then gets, and does not get:

- the deferred is settled **only** by the regime-2 routing reaction, i.e. only after the call returned
  normally — so a throw from the call itself can never race a settlement (this is what makes D6 possible);
- the routing accepts **only** a value the intrinsic `Promise.prototype.then` accepts **and** whose species
  resolution completes. A non-thenable or a custom thenable throws synchronously (caught, logged via
  `safeLog`) and the run is left to the deadline — the **supported path is reachable only with the
  SUPPORTED value**, by construction rather than by hope (D2.3, E16);
- it does **not** buy protection against a native promise whose `constructor` **or** `Symbol.species` read
  throws. `then` is not a pure internal-slot operation: `PerformPromiseThen` calls `SpeciesConstructor`,
  which reads `promise.constructor` and then `constructor[Symbol.species]` (E32, **E44**). For the SUPPORTED
  value both reads are safe; for a tampered one either throw lands *before* the reaction is queued, so the
  rejection is unowned and the host's unhandled-rejection policy applies — **the residual**, named in the
  contract and at the site. There is no containment to add: every other attach path ends in the same read
  (E44, four paths × two policies);
- a **hostile thenable** that calls `resolveSettled()` synchronously inside `then()` and *then* throws is
  **outside** the contract and is also **outside the routing** (the intrinsic refuses it, so its `then` is
  never called). Its worst case under r2 — the success body running for a possibly-live run — is not
  reachable through the routing at all.

**Why not design for thenables** (Q2 row R2): the only way to be correct for them is a settle-once latch
plus the r1 sentinel plus a post-`failPreStart` guard — three mechanisms for a value the SDK cannot return,
each of which then needs its own tripwire, and the tripwire is precisely what failed in r1 (critique r1
#6) and again in r3 (critique r3 #1). r4–r6 instead *reject* them at one line, and name the residual
classes (Proxy, a species-throwing native promise) that cannot be rejected.

**Falsifier:** the installed SDK's `prompt` signature/implementation stops being `async`/`Promise<void>`,
**or** a call site passes a wrapped/non-native value (which voids D2.1 as well as D3), **or** a session hands
back a promise whose `constructor` **or** `Symbol.species` was tampered with (E32/E44 then exit the host;
re-derive before claiming otherwise). Either of the first two reopens Q2 with R2.

### D4 — The caller-visible status: accept `running` at the caller's resume (critique r1 #3) — unchanged in r4

The deferral costs exactly one microtask hop, and the hop is **caller-visible** (r1 called it "measured
harmless" — measured at the test level, not at the caller level):

| | `await spawnBackgroundSession(...)`, immediately-resolved prompt |
|---|---|
| baseline (attach on `runPromise`) | the caller resumes with `agent.status === 'completed'` |
| shape (b) (attach on the deferred) | the caller resumes with `agent.status === 'running'`; `completed` one tick later |

Measured twice: a standalone probe and the real harness (§Evidence E1, E8). r4 does not change the hop
count: the intrinsic routing is the same function for a native promise (E22), and T6 (which asserts
`running` at resume **and** `completed` one tick later) is green in r4 (E29).

**Decision: accept it**, and make it a *contract* instead of a race:

> **Acceptance criterion D4.** For every prompt shape — already resolved, pending, hanging — at the
> caller's first statement after `await spawnBackgroundSession(...)`, `agent.status === 'running'`. The
> same statement in the pipeline is the identity capture (`background-pipeline.ts:568`,
> `status: agent.status`), so `identity.status` is deterministically `running`.

**Pipeline / identity consequence.** `spawnBackgroundRun` formats `Status: ${spawned.identity.status}`
(`background-pipeline.ts:995`) from that snapshot, so for an immediately-finished run the spawn result now
says `Status: running` where it used to say `Status: completed`. That is the *intended* reading of the
text it accompanies ("Background agent started … You'll be woken with a completion message when it
finishes"); the old value was a scheduling race, not a guarantee. Nothing branches on it: the identity
record has exactly one read (`status: agent.status` at `:568` is the capture,
`Status: ${spawned.identity.status}` at `:995` is the only consumption), and
`buildMonitoringDegradedParagraph` takes only `id`/`label` (§Evidence E13). The run's real outcome is
unchanged (same terminal record, same event, same wake).

**Test-only changes:** none in the existing 172 tests — measured, not assumed (§Evidence E4, re-measured in
r4 at E29). The decision is pinned by one **new** test that also pins the pipeline capture point (no
`await` between the spawn and `status: agent.status`), because that is the statement whose position makes
the snapshot deterministic. That test is red on the baseline (`completed` vs `running`, §Evidence E8).

Options and falsifiers for this decision: **Q1**.

### D5 — Non-`Error` throws and a catch path that cannot mask: total normalisation, contained steps, contained logs (critique r1 #7, r2 #4; limit narrowed r4 #2; catch-path logging contained r5 #3)

`prompt()`'s rejection value and a synchronous throw are both `unknown` by contract. r2 said "normalise
with `String`". The round-2 critique showed two holes:

1. **`String(reason)` itself throws** (`Symbol.toPrimitive`/`toString` that throws, a Proxy), and
   `reason instanceof Error` throws for a Proxy whose `getPrototypeOf` trap throws — a normaliser that is
   not total *replaces* the failure it describes (E18, test "preserves original unstringable reason":
   pre-fix the caller received `Error: conversion failed`, not its own object).
2. **`failPreStart` is not fault-contained.** Its first step is `cleanupWorkBranch()`, and the teardown's
   own catch blocks logged `(err as Error).message` — so a git helper rejecting with `null` made the
   *teardown* throw a `TypeError`, `failPreStart` never reached `finalizeRunEntry`, and the caller got
   `Cannot read properties of null` instead of its prompt error (E18, pre-fix).

r3 fixed both layers; r4 keeps the code and **adds the mutants that make the containment testable**
(finding #2):

```ts
// module level, total for EVERY value (a Proxy, a hostile toPrimitive, null, undefined)
function normalizeThrown(thrown: unknown): Error {
  try {
    return thrown instanceof Error ? thrown : new Error(String(thrown));
  } catch {
    return new Error('unprintable thrown value');     // never a second throw
  }
}
function thrownMessage(thrown: unknown): string {
  try {
    return normalizeThrown(thrown).message;
  } catch {
    return 'unprintable thrown value';                // an Error-shaped Proxy whose .message throws
  }
}
```

```ts
const failPreStart = (message: string): void => {
  if (deadlineHandle) clearTimeout(deadlineHandle);
  // EVERY step is contained: a throw here would replace the original spawn failure at
  // every call site (all three do `failPreStart(...); throw err`).
  try {                                      // ← STEP 1 — teardown (defence in depth, M18)
    cleanupWorkBranch();
  } catch (err) {
    safeLog(() => log.error(               // ← r5: the SINK is contained too (finding #3)
      `spawnBackgroundSession: work-branch teardown failed for ${id} — the original spawn failure is preserved`,
      { error: thrownMessage(err) }));
  }
  try {                                      // ← STEP 2 — finalize (BEHAVIOURALLY PINNED, M16)
    finalizeRunEntry('failed', message);     // terminal retirement is still ATTEMPTED
  } catch (err) {
    safeLog(() => log.warn(`spawnBackgroundSession: pre-start finalize failed for ${id}`,
      { error: thrownMessage(err) }));
  }
  try {                                      // ← STEP 3 — registry retire (PINNED via the call, M17)
    clearInflightRun(id);
  } catch (err) {
    safeLog(() => log.warn(`spawnBackgroundSession: pre-start registry retire failed for ${id}`,
      { error: thrownMessage(err) }));
  }
};
```

Normalisation sites, and why each: the pre-start message (`thrownMessage(err)` in regime 1), the
never-issued stamp (`neverIssued`), the fault body's binding (`normalizeThrown(reason)`), the four
`cleanupWorkBranch` catch sites (`getCurrentBranch`, `captureDiff`, `restoreHead`, `deleteBranch`), the
branch-setup refusal (its `sanitizeErrorMessage((err as Error).message, …)` masked a non-Error git fault
before the refusal was even built), and both settle-body catch-alls' log lines. **Measured coverage:**
`grep -c "as Error).message" src/session-manager.ts` goes **12 → 5**, of which one is a comment; the four
remaining code sites (`:1235` `stopAgent`, `:1281` `steerAgent`, `:2456`/`:2477` the deadline timer body)
are **out of this unit's scope** and flagged in §Risks.

- The original throw is preserved (`throw err`, not a re-wrapped error) — `throw null` still rejects the
  spawn with `null`; an unprintable object still rejects with **that object** (`rejects.toBe`, T4 case 4).
- The rejection body keeps its old identifier (`err`) so its ~40 lines are untouched; the value is narrowed
  once, before any `.message` use.
- **No `finally` is needed for the deferred** (critique r1 #7 asked for one because r1 released the
  deferred *after* `failPreStart`): under D6 the pre-start catch never touches the deferred, so no fault in
  `failPreStart` can skip a release. The `finally` requirement is satisfied structurally.

**Falsifiers (all used):** (i) a git cleanup that rejects with `null` must not change the error the caller
receives, and the terminal entry must still be written — T4 case 3, pre-fix red (`Cannot read properties of
null`), post-fix green (E18); (ii) an unstringable thrown object must arrive as itself — T4 case 4,
pre-fix red (`Error: conversion failed`), post-fix green (E18); (iii) **NEW r4:** a **terminal write** that
throws (the third `appendEntry`) must not replace the original throw — T4 case 5, red under **M16**
(`expected Error: append blew up to be Error: original prompt`, E26), and the **registry retire must still
be attempted** — T4 case 5's `clearInflightRun` spy, red under **M17** (E28).

**Honest limit — narrowed in r4 to the TEARDOWN catch (finding #2).** r3 said "there is no behavioural
mutant that kills only the containment", unqualified, and the critique showed that is false for the
*finalize* step (M16 goes red) and for the *registry-retire* step (M17 goes red). What remains true is
narrower:

- **STEP 1 (teardown) has no behavioural mutant.** With the teardown's own catch sites normalised, the
  harness cannot make `cleanupWorkBranch` throw out of `failPreStart`, so deleting **only** that `try/catch`
  is not observed — **measured**: M18 (delete the teardown catch) **passes T4** (`Tests 1 passed`, E28).
  It is kept because it is what makes "never mask the original" true *independently* of every future
  teardown edit; a reviewer who wants it gone must show that no step of `cleanupWorkBranch` can throw.
- **STEP 3's catch is also unreachable** — but its *call* is now pinned: `clearInflightRun(id)` is
  `run-registry.ts:261`, which swallows its own `unlinkSync` errors and whose `resolvePath` catches every
  id fault, so the `catch` around it cannot fire from the harness. M17 therefore kills a **deleted step**,
  not a deleted `catch`; both are stated as the limit rather than papered over.
- **STEP 2 is fully pinned** (M16): the finalizer's write is a real, reachable throw site.

#### D5.1 — A throwing log sink cannot replace the error it reports (r5 finding #3)

The three steps above are contained **in code**; their log lines were not. `src/logging.ts:158–160` calls the
console mirror **outside** its file-write `try/catch` (the call itself is `:159`):

```ts
// src/logging.ts (unchanged — the global fix is #543, out of scope)
if (consoleOutput) {
  const consoleMethod = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  consoleMethod(`[${prefix}] ${level.toUpperCase()}: ${message}`);   // ← can throw; not inside a try
}
try { /* file write */ } catch { /* silently fail */ }
```

So with `setConsoleOutput(true)` and a `console.warn` that throws, `log.warn` throws — and inside a catch
block that throw **becomes the caller's error** and **skips every later step**. Measured on the r4 tree
(E35): T4 case 5 received `console blew up` instead of `original prompt`, and the retire step never ran.

**The r5 fix — one module-level helper, pasted verbatim (this is the exact shape):**

```ts
/**
 * Issue #450 (D5, critique r4 #3): a log call on an ERROR path must never
 * replace the error it reports. `src/logging.ts:158–160` calls the console mirror
 * OUTSIDE its file-write catch, so with `setConsoleOutput(true)` and a throwing
 * `console` sink, `log.warn` throws — and in a catch block that throw becomes
 * the caller's error, and skips every later step of the cleanup. This wrapper
 * swallows a sinking logger fault. The global fix is #543; this containment is
 * local to the settle/pre-start paths and is what makes "the original error
 * survives" true for them.
 */
function safeLog(write: () => void): void {
	try {
		write();
	} catch {
		// a throwing sink must not mask the original throw nor skip a later step
	}
}
```

**Why a thunk and not `safeLog('warn', message, data)`** (measured, E38): a level-branching signature needs
`level === 'error'`, and `src/__tests__/terminal-status-consistency.test.ts` — the structural guard — reads
that comparison as a re-implementation of the terminal-status predicate and **fails the full suite**
(`src/session-manager.ts:143 [comparison:error] level === 'error'`). The thunk has no level logic and no
`==` against a status literal, so the guard stays green (E38: full suite, identical failing set).

**The six call sites, and why each is one** (all inside `spawnBackgroundSession`'s span except the helper):

| # | Site | Why the sink must be contained |
|---|---|---|
| 1 | `failPreStart` step 1 (teardown) | `throw err` follows; a sink fault would replace the prompt error |
| 2 | `failPreStart` step 2 (finalize) | same — this is the T4 case 5 path; the retire step is **after** it |
| 3 | `failPreStart` step 3 (registry retire) | the last step before `throw err` |
| 4 | `onSettled`'s catch-all | `markTerminalBestEffort('completed')` follows; a sink fault would skip it and reject the deferred's `.then` |
| 5 | `onSettleFault`'s catch-all | `markTerminalBestEffort('failed')` follows; same |
| 6 | regime 2's catch | `return agent;` follows; a sink fault would **reject the spawn** (the #439 boundary) |

**Honest limit — re-measured in r6 with an instrument that works (finding #4).** r5 said "sites 1–3 are
pinned by T4 case 6" and, in E42, that the two existing catch-all tests never reach their log lines — both
measured with a `console.log` marker. That instrument is **blind in this harness**: vitest prints a
*passing* test's console output nowhere (control, E45: the same `console.log` line is printed by a failing
test and by nothing when the test passes), so "marker printed 0 times" proves nothing. r6 installs a
**file-write** marker at each of the six sites and measures reachability (E45):

| Site | Location | Reached by (file-marker hits) | Containment behaviourally pinned? |
|---|---|---|---|
| 1 | `failPreStart` step 1 (teardown) | **no test** (0) | **no** — construction only; the step cannot throw through the harness (M18 GREEN) |
| 2 | `failPreStart` step 2 (finalize) | **T4 cases 5 and 6** (2 hits) | **yes** — T4 case 6 (throwing `console.warn`, E35) |
| 3 | `failPreStart` step 3 (registry retire) | **no test** (0) | **no** — construction only; M17 pins the *call*, not the catch |
| 4 | `onSettled`'s catch-all | **`review C: a throwing settle…`** and **`releases the ref via markTerminalBestEffort…`** (1 each) | **no** — both tests reach the line, neither makes the sink throw there |
| 5 | `onSettleFault`'s catch-all | **no test** (0) | **no** — construction only |
| 6 | regime 2's catch | **T3 cases 1 and 3** (2 hits) | **yes** — T3 case 3 (throwing `console.error`, E35) |

So: **site 2 is behaviourally pinned; sites 1 and 3 are construction-only unless separately demonstrated**;
site 6 is pinned on the routing path; and site 4 — which r5 called by-construction — **is reached**, which
makes a pin cheap if the conductor wants one (open question 5: one variant test, ≈30 test lines on an
already-declared over-allowance delta). The record itself is still **lost** when the console mirror throws
first (the mirror runs before the file write): that is `logging.ts`, not this containment, and it is why
T4 case 6 asserts *the error and the retire step*, not *the log line* (E35).

### D6 — The pre-start catch does **not** settle the deferred (replaces r1's sentinel) (critique r1 #6, #8; tripwire replaced r4 #1)

```ts
  } catch (err) {                 // REGIME 1
    …
    failPreStart(sanitizeErrorMessage(reason, effectiveCwd));
    throw err;                    // ← and nothing else. No sentinel, no rejectSettled.
  }
```

`failPreStart` has already classified the run exactly once: deadline cleared, branch torn down, terminal
run entry written (which also writes the `.done` settle marker), registry entry retired. Settling the
deferred afterwards would run a settle body a second time over the same run.

Why abandonment is safe here, and why the r1 sentinel was not worth keeping:

1. **No leak.** An unreachable pending promise and its handler closures are collectable — probed with
   `--expose-gc` + `FinalizationRegistry` (§Evidence E2: `collected: ['closure-payload']`).
2. **Unreachable in this path.** The routing never ran, the deadline was cleared, and nothing else captures
   `settled`; the only other reference is the spawn scope itself, which the pre-start path already roots
   through `agents` and `agent._sessionRef` (D8/E7). The deferred adds **no** root.
3. **The sentinel was unprovable.** Its only job was to stop a second terminal pass, and r1's tripwire for
   that (F1's `SETTLED_RUN_WRITES` count) is blind: the finalizer's `entryWritten` guard masks the repeat,
   and the critic's no-guard build passed F1. A guard whose removal is not observed is not a guard.

The deferred is still settled on every normal path (the routing resolves/rejects it), so shape (b) does not
leave it dangling in production.

#### D6.1 — The tripwire, third attempt: an entry marker that cannot be conditional (r4 finding #1)

T5's job is to prove "**no settle body ran**" on the pre-start path. Three attempts, and the first two were
measurably blind:

| Attempt | Mechanism | Blind to | Evidence |
|---|---|---|---|
| r1 | `SETTLED_RUN_WRITES` count (F1) | the finalizer's `entryWritten` guard masks the second pass | critique r1 #6 |
| r2/r3 | completion transcript line + terminal event | a body that throws **before** its writes | critique r2 #5 (M12) |
| r3 | the same, **plus** `clearTimeout` called exactly once | a body entered **when the handle is already unset** — the count stays 1; and any text-level pin that a comment can satisfy | **critique r3 #1**, re-measured as M14/M15 (E26) |
| **r4** | **`markSettleEntry(kind)` = the bodies' first statement, at `debug`, independent of every other subsystem**; T5 asserts **zero** records; T1 pins the marker inside the **brace-matched, comment-masked** body | — (this is the observable the two critic mutants cannot satisfy) | E26 (M14 red, M15 red on T1), E27 (M15 invisible to T5 — so T1 is the independent instrument), E25 (neutrality) |

So T5 asserts, on the sync-throw path:

1. no `Transcript completed:` line (a settle body's only transcript write on success),
2. no `subagent:failed` event,
3. exactly `SETTLED_RUN_WRITES` (3) run writes, terminal status `failed`,
4. **zero `settle body entered` records** (NEW r4 — the marker; independent of the timer handle and of any
   later write),
5. the `clearTimeout` count is exactly 1 (kept from r3 — this is now the **second**, redundant entry
   signal, and it still pins D7),
6. **a positive control** — an immediately-resolving prompt in the same test must produce **exactly one**
   record (`(success)`), so "zero" is evidence rather than a blind detector.

Measured: green tree → `1 passed`; M8 (`rejectSettled(err)` after `failPreStart`) → red on (1); M12 (M8 +
fault body dying on its first line) → red on (5) at `expected 2 to be 1`; **M14** (handle unset + body dies
on its first line — the critic's build) → red on **(4)** at `a settle body was ENTERED on the sync-throw
path: expected 1 to be +0`, **with (5) still passing at 1** — exactly the blindness r3 had (E26); **M15**
(block-comment decoy) → T5 **passes**, T1 red (E27).

### D7 — Deadline interaction (unchanged owner, one new path that must not claim it)

- The deadline is armed at `:2462`, before the acceptance write and before the deferred — **unchanged**.
- **Regime 1's catch** clears it via `failPreStart` (`:1943`); r1 was right that no new `clearTimeout` is
  needed, and r2–r4 keep that (the timer count assertion in #448's test at `:1007` still passes).
- **`onSettleFault`** keeps its existing `clearTimeout` as its first **deadline** statement — now the
  body's **second** statement, behind `markSettleEntry('fault')`. This is the falsifier target of T2
  (mutant M1) **and** T5's second entry signal.
- **The success body** likewise: marker first, then `clearTimeout` (`:2502` → unchanged position relative to
  the deadline work).
- **Regime 2's catch does NOT touch the deadline.** It is the monitor of last resort for an unmonitored run,
  and ADR 0023 decision 1 forbids a second bound. The `timeout`/`prune: false` snapshot it produces is what
  keeps a still-writing session's dir and branch.

### D8 — What the pre-start path actually retains (claim narrowed) (critique r1 #8) — unchanged in r4

r1 claimed "nothing is released → nothing to release". The honest statement, measured (§Evidence E7):

| Object | After a pre-start throw | Owner |
|---|---|---|
| terminal **run entry** | `failed`, one write | durable store (correct) |
| `.done` settle marker | written by `finalizeRunEntry` → `markSettled` | scratch dir (correct) |
| in-flight registry entry | retired | `clearInflightRun` (correct) |
| **agent record** | still `running` in memory **and on disk** | `agents` map (`:1576`), `persistAgent` |
| **`agent._sessionRef`** | still the live session | `:1988`; released only by `captureAndReleaseSession` / `markTerminalBestEffort` |
| deferred + handler closures | collectable once the deadline is cleared | none (D6) |

So: **rejecting the deferred alone would not release the session graph either** — the graph is rooted by
`agents` and `_sessionRef`, independently of the deferred. r2–r4 therefore claim **only** collectability of
the deferred, and state the agent-record/`_sessionRef` retention as a **pre-existing** property of the
pre-start path (the same shape #460 §4.4 recorded for `failPreStart`: it stops at the run entry).

**Out of scope, flagged not fixed** (surgical boundary): a pre-start failure leaves an agent record
`running` while its run entry says `failed` — filed as **#542**, not this cycle (§Conductor decisions).


### Q1 — The caller-visible status (D4) — unchanged, decided

| Option | Mechanism | Blast radius | Cost | Risk if wrong |
|---|---|---|---|---|
| **S1 — accept (decided, r2 + r3 + r4)** | keep the deferral; document that the spawn reports `running` at the caller's resume and pin it (T6) + pin that the pipeline capture has no `await` between spawn and snapshot | one caller-visible value changes for an immediately-resolved prompt: `completed` → `running`; the spawn result text reads `Status: running`; the terminal record, event and wake are unchanged | 1 test; **0** changes to the 172 existing tests (measured, E29) | a caller that inferred "already finished" from the spawn result loses that inference — it still gets the completion event and `get_subagent_result`; the run's outcome is untouched |
| S2 — preserve the old timing (shape (c)) | drop the deferral: keep the handlers attached directly to `prompt()`'s promise (today's shape), add the *policy* pin only (ratchet), keep the pre-arm | zero timing change; **the structural guarantee is gone** — the window stays one statement wide and is protected only by a source ratchet | smaller src delta (~+10 lines); the ratchet carries the whole guarantee | a rewrite that satisfies the ratchet's spelling but throws at runtime loses the settle again; also reverses the shape (b) decision recorded on the issue → conductor sign-off required |
| S0 — do nothing | — | none | none | the defect stays and no test goes red when a future edit re-opens it |

**Decided: S1** (conductor, 2026-11-20). r4 adds no new option here and re-measures the pin (E29, T6
green; E8, red on the baseline).

### Q2 — The return contract for `prompt()` (D2.3, D3) — decided (R1′) in r3; **narrowed in r5**, no new option taken

| Option | Mechanism | Blast radius | Cost | Risk if wrong |
|---|---|---|---|---|
| **R1′ — intrinsic routing (decided, r3–r6)** | `Promise.prototype.then.call(runPromise, …)`: the value's own `then` is never read; the SUPPORTED value (CONTRACT C450-R6) is byte-equivalent to `runPromise.then(…)`; a tampered `then` accessor cannot strand a rejection; a **necessarily rejected** value throws synchronously → log (`safeLog`) → deadline. **r5 narrowed the claim; r6 completed it**: the species step reads `constructor` **and** `Symbol.species`, so the supported class is "both reads safe", not "`constructor` safe" (E44) | one statement + the contract comment in regime 2; no timing change for native promises (E22); a custom thenable that r2 would have routed now fails closed to the deadline (intended, D3); a species-throwing or `constructor`-throwing native promise remains a process residual (E32/E44) | 1 line; 0 hops; T3 has two more cases (2 and 3) | if some real session returns a non-native thenable, that run becomes deadline-monitored instead of routed — measured: **no** such fixture in the suite (E23: 99 `session.prompt.mock*` assignments, 0 custom thenables), and the SDK's `prompt` is `async` |
| R1 — state the contract, keep `.then` (r2's shape, critique-acceptable minimum) | keep `runPromise.then(…)`; write "the supported value is a native `Promise<void>`; a routing fault is out of contract and the process residual is the host's unhandled-rejection policy" at the site | 0 production lines beyond the comment; the critic's reproduction still exits the host (E16 pre-fix side) | 0 | a tampered `then` accessor on a native promise is **containable for free** and left uncontained; the residual is real where it need not be |
| **R4 (new, r5) — guard the species read** | add `try { void runPromise.constructor; } catch` before the routing, so a tampered `constructor` is logged as *out of contract* instead of surfacing as the intrinsic's `TypeError` | 3 lines in regime 2 | +3 lines, +1 branch, 0 hops | **buys no containment** — the rejection is still unowned and the host still exits 1 (E32) — it only changes the message. Rejected: a nicer log is not worth a branch that reads like a guard, and the existing catch already logs the failure |
| R3 — contain everything (`Promise.resolve` / `Promise.race`) | own the value before routing | every prompt shape | 1 line + T3 rewrite | **rejected on evidence**: assimilation turns a non-thenable into a *resolution*, so `{}` would run the success body and record a live run `completed` — it breaks T3's contract (**M20** re-measured, E46), and it does not contain the species residual (E44: `Promise.resolve(p).then` and `Promise.race([p]).then` throw the same error) |
| R2 — design for thenables | settle-once latch + sentinel + post-`failPreStart` guard; new tests for resolve-then-throw | every settle path gains a guard; two extra states | ~+25 src lines, +2 tests, and the r1 sentinel's unprovable tripwire problem returns | the guards are unreachable in production, so their removal is unobserved; more surface for class-2 misclassification |
| R0 — r1 | r1 kept the "handles malformed returns" claim without a mechanism | — | — | reproduced by the critique: `failPreStart` writes, then the success body writes |

**Recommendation: R1′** (decided; r5 narrowed its claim, r6 completed the narrowing — the mechanism has not
changed). It is the minimal change that makes the supported path *provably* unable to strand a rejection
**for the one value the contract names**, and it costs zero hops. The finding, twice refined: `then` is not
a pure internal-slot operation — `SpeciesConstructor` reads `constructor` **and** `Symbol.species` — so the
supported class is "both reads safe", and the residuals (a Proxy over a promise; a native promise whose
`constructor` or species read throws) are named rather than papered over. The measured-accepted values
(subclass, cross-realm) are recorded as accepted, not as rejected.
**Falsifiers:** (a) a real (non-test) session whose `prompt` returns a non-native thenable — then the run
silently loses its routing and R1 (state-only) or R2 becomes the choice; (b) the SDK's `prompt` ceasing to
be `async`/`Promise<void>` (also voids D2.1); (c) a session returning a promise with a throwing
`constructor` getter **or** a throwing `Symbol.species` on its constructor — E32/E44's `exit=1` is then the
observed behaviour, and no option in this table fixes it.

### Q3 — The shape of the ordering ratchet (critique r1 #4; mechanism fixed by critique r2 #3; pin fixed by critique r3 #1)

| Option | Mechanism | Blast radius | Cost | Risk if wrong |
|---|---|---|---|---|
| **G1′ — closed window list, indentation-agnostic, plus executable-body pins (recommended, r4; both regime bodies added r5)** | slice the window (`:2472` → the routing); walk its lines: every non-blank, non-comment line must be the **next declared entry** — its exact text, at **any** indentation — or lie inside an entry's declared block (`try { … }`, `new Promise(… => { })`, the marker declaration, the two handler declarations); blocks are skipped to their declared closer at the window's own indent; then, for **each** of the four bodies (both regimes, both settle handlers), a **comment/string/regex-masked, brace-matched** slice: the regime bodies must **open on** their one declared statement and contain exactly it, and each settle body's first two executable lines must be the marker and the deadline clear | test-only; couples the test to the region's statement *text*, not its indentation or line numbers | ~95 test lines + ~170 for the masker and the three body readers (r5: the masker learns regex literals, and the regime reader is new); any legitimate addition edits the list (a decision, by design) | a benign restructure goes red (annoyance); a statement hidden **inside** a declared block (a handler body, a catch body) is out of the ratchet's scope — stated, and covered where it matters (M8/M12/M14 by T5, M15/M19 by the body pins, M6/M7 by the regime pins) |
| G1 — r2's list of statement heads at two-space indent | no bracket logic; indentation is the continuation signal | test-only | ~60 lines | **proven insufficient**: a four-space top-level `if (…) throw …` passed it (E17: r2 scan green, r3 scan red on the *same* mutant source) |
| G1-regex — r3's unanchored body regexes | two `regex` literals over `windowSrc` | test-only | ~6 lines | **proven insufficient**: a block-comment decoy satisfied both (M15; r3's pin passes the same source — E27), so the pin must locate the declaration in masked text and brace-match |
| **G1′-hash — the round-5 critique's cheaper alternative: an indentation-normalised window snapshot (or its hash)** | normalise the window's whitespace and compare all of it against a stored snapshot / a stored sha256 | test-only; ~15-25 lines instead of the ~443-line instrument (masker + readers + T1 + T7) | small in lines | **rejected — quality, not budget.** (a) **Opaque**: a failure says "the window changed", never *which* statement was inserted; the report the rest of this spec relies on (`window line N is not the declared statement: expected … to be …`) disappears. (b) **It pins comments**: any comment edit flips it, and the r6 contract comment alone (21 lines inside the window's REGIME 2 block) would have rewritten the snapshot — the instrument would fire on the very edit this patch makes. (c) **It pins the spelling, not the property**: an equivalent implementation passes only by re-baselining the hash, which is the "blindly regenerated snapshot" the critique itself warns about. It was measured to *detect* all four decoys (M14/M15/M19/M21 differ under normalisation), so it is sufficient as a detector — it is rejected for (a)–(c). **Budget note (r6 correction):** the critique's "it does not by itself bring the delta under 514" is not supported by the r6 line counts — the instrument is ≈390–440 of the 909 added test lines and the five behavioural tests are ≈420, so a ~15-line replacement would likely bring the delta **under** the 556 allowance. The declaration is therefore a cost chosen for a legible failure, not one the instrument forces; the conductor may overrule this row (open question 6). |
| G0 — no ratchet | review only | — | 0 | the ordering property the issue keeps in scope stays unpinned |

**Recommendation: G1′ + the executable-body pins** (the conductor's G1 decision stands; the mechanism is
what changes, twice: r4 for the settle bodies, r5 for the regime bodies). It goes red for a **throwing statement at any indentation** and for a **decoy comment that
spells the body head**, which are the two fault classes this window has; it does not pin line numbers; an
equivalent implementation passes by amending the list, which is the recorded decision the issue asks for.
**Falsifiers:** a legitimate statement added to the window that the list cannot express without losing the
property — then the entry gains a per-row "cannot throw" annotation rather than the ratchet being dropped;
or a *third* way to spell a fake body head that the mask does not cover — then the pin must be derived from
a real parser, which the toolchain does not offer (E11). A construct the masker cannot classify is
**fail-closed** (T7): the pin goes red instead of reading text it cannot parse. Named mutants that **must**
go red: M3–M7, M11, **M15**, **M19**, **M21** (§Mutants: 21 cases re-measured on the r6 tree by the
self-contained gate in §Appendix A — **20 RED, M18 GREEN by design, `tsc=0` everywhere**, E46).

## Acceptance criteria

Each is a claim an implementer can check; `T*`/`M*` are the tests and mutants in §Tests / §Mutants.

1. **The attach precedes the call.** `settled.then(onSettled).catch(onSettleFault);` is a single statement
   above `session.prompt(`, and the window between the acceptance write and the routing is the closed
   **12**-entry list (r4 adds the marker declaration). (T1; M3 → red, measured.)
2. **No statement can be inserted on either side of the call, at any indentation, and neither regime body
   can be faked**: before the deferred (M4), between the attach and the call (M5), inside regime 1 (M6),
   inside regime 2 (M7), a **four-space-indented top-level statement** after the attach (M11), and **both
   regime bodies are pinned as executable one-statement blocks read from comment/string/regex-masked text**
   — so a **comment** decoy (M19) or a **template-literal** decoy (M21) that spells the expected `try` text
   no longer satisfies the pin. (T1; all red with `tsc` exit 0 — measured on the r5 tree, E38, and
   re-measured on the r6 tree by the self-contained gate, E46.)
3. **A synchronous `prompt()` throw is treated as pre-start *under D2.1* and classifies once**: one terminal
   run entry (`failed`, the original message), deadline cleared, branch torn down, registry retired, **no
   settle body side effects** (no completion transcript line, no terminal event), **no settle body entered
   at all** — **zero `settle body entered` records** *and* exactly one `clearTimeout` — and the
   never-issued classification is justified **only** by the three D2.1 clauses, which are asserted to be
   present at the site by review (r4 finding #3: the wrapper shape of E24 is explicitly *not* covered —
   `live=true` after the synchronous throw). (F1 test unchanged + T5; M8, M12, **M14** → red, measured.)
4. **A throw after the call is post-start**: `failPreStart` is not called (no never-issued message, no
   prune), the spawn resolves, and the deadline remains the bound and classifies the run `timeout`. (T3;
   M2 → red, measured.)
5. **An async rejection routes through the deferred**: `agent.status === 'failed'`,
   `result.stopReason === 'error'`, run entry `stopReason: "error"`, exactly one terminal write,
   `subagent:failed` emitted, and the deadline cleared (fake timers: 1 → 0). (T2; M1 → red, measured.)
6. **Non-`Error` values work on both regimes**: `throw null` → `errorMessage: "null"` + original rethrow;
   `reject(undefined)` → `errorMessage: "undefined"`. (T4 cases 1–2; M9, M10 → red, measured.)
7. **A fault in ANY of `failPreStart`'s three steps cannot mask the original throw, normalisation is
   total, and neither can a throwing log sink**: (i) a git teardown that throws `null` still rejects the
   spawn with the prompt error **and** writes the terminal entry (T4 case 3, pre-fix red, post-fix green,
   E18); (ii) an unstringable thrown object rejects with **that object** (T4 case 4); (iii) a **terminal
   write that throws** (the third `appendEntry`) still rejects with the original error and logs
   `pre-start finalize failed` (**M16** → red with `append blew up`, E26); (iv) the registry-retire step is
   asserted **separately** by a `clearInflightRun` call observation plus the registry's end state
   (**M17** → red, E28); (v) **NEW r5:** a **throwing `console.warn`** on that same path — with
   `setConsoleOutput(true)` — still rejects with the original error **and** the retire is still attempted
   (**T4 case 6**, pre-fix red at `expected Error: console blew up to be Error: original prompt`, post-fix
   green, E35). The global `logging.ts` fix is **#543**; this criterion is about the local `safeLog`.
8. **The routing contract is exactly CONTRACT C450-R6, and it is the same text in all three places**
   (the site comment printed in D2.3, D3, and here). A native `Promise<void>` whose own `then` accessor
   throws is still routed, so its rejection is handled (T3 case 2; M13 → red); a non-thenable or custom
   thenable throws at the routing, is logged, and leaves the run to the deadline (T3 case 1); a throwing
   log sink on that path must not turn the routing fault into a rejected spawn (T3 case 3, E35).
   In full:

   > SUPPORTED — an ordinary native `Promise<void>` of this realm whose `constructor` and `Symbol.species`
   > reads BOTH complete without a throw and resolve to the intrinsic `Promise` (the species step reads both:
   > SpeciesConstructor is `promise.constructor[Symbol.species]`).
   >
   > UNSUPPORTED — every other value: NO GUARANTEE. Measured, it splits in two.
   >
   > (i) NECESSARILY REJECTED, the intrinsic cannot attach: a non-thenable, a custom thenable, or a Proxy
   > around a promise (TypeError at the receiver check); and a promise whose species resolution throws — an
   > own `constructor` getter, a non-object `constructor`, or a throwing `Symbol.species` on the constructor.
   > These throw HERE, synchronously, before any handler exists; the run is left to the deadline.
   >
   > (ii) MEASURED ACCEPTED, not relied on: a same-realm `Promise` subclass instance and a cross-realm native
   > promise both route and deliver (probe species-contract.mjs, variants `subclass`/`cross-realm`, exit 0).
   > Neither is producible by this realm's `async` method.
   >
   > THE RESIDUAL: class (i)'s promise-shaped members — a Proxy over a promise, and a species-throwing native
   > promise — carry a rejection that no handler owns, so the host's unhandled-rejection policy applies and
   > node exits 1 (default and strict; probe `species-contract.mjs`, variant `intrinsic-species-throws`:
   > constructor === Promise, species read throws). No containment exists here: every attach path performs
   > the same species read (Promise.resolve, Promise.race and `await` all do).

   Evidence: E44 (7+4 probe variants × 2 policies) for the classes, E16/E32 for the earlier rows; the
   residual has **no** test — a deliberate host exit is not expressible in vitest and any in-process
   handler would defeat the measurement — so the probe is the falsifier (row **C3**), exactly as C2 is for
   the `constructor` residual.

9. **The never-issued proof is scoped, and the scope is IN THE CODE**: the call site passes the **unwrapped**
   SDK method and a pure argument; the three preconditions are pasted into the REGIME 1 comment and into
   `failPreStart`'s doc comment (exact text in D2.1); a wrapper that starts work then throws is *out of
   contract* and is **not** claimed as pre-start (`live=true`, E24). (E24 + the D2.1 site text; no source
   mutant — the probe is the falsifier, §Mutants row C1.)
10. **The successful path is unchanged** except the status hop and one `debug` record:
    `done` entry, branch capture, transcript `completed`, one terminal write, `completed` one tick after
    the caller's resume. (Existing suite + T6 + E25: the record is invisible at the default level.)
11. **The caller-visible status is pinned** (`running` at resume, pipeline capture deterministic). (T6; red
    on the baseline — E8.)
12. **The pin's instrument reads only what it can classify, or refuses**: every case in T7 either returns
    the **true** body or **throws**; no case returns a truncated body. (T7, 14 cases, measured E34 —
    including the critic's two reproductions, a template literal with `${}` braces, a block comment inside
    the body, a line comment with `}`, nested braces, a string carrying `/*`/`}`, a division, and three
    fail-closed cases.)
13. **Full suite**: zero new failures against the baseline **on the same corpus**. Measured on a
    full-corpus tree (the repository + the two r5 files, E36/E39): base `3039 / 2979 passed / 59 failed /
    1 skipped / 6 failed files / 23 failed suites`, r5 `3046 / 2986 / 59 / 1 / 6 / 23` — **added failing
    names: ∅**, removed: ∅ (compared by normalized full name, not arithmetic). **Re-measured for r6**
    (E47) on two trees of the *same* corpus (both without `.git`, which is what the 10-test difference
    between corpora is): base `3039 / 2969 / **69** failed / 1 skipped / **31** failed suites`, r6
    `3046 / 2976 / 69 / 1 / 31` — **added failing names: 0, removed: 0**, compared by normalized
    (file basename, fullName) pair. The absolute counts differ between corpora because a tree without
    `.development`/`.git` cannot satisfy the git- and doc-reading tests; the comparison is set-based and
    same-corpus, never arithmetic across corpora.

## Tests

### New — 7, in `src/__tests__/session-manager.test.ts`, all inside one `describe("#450 settle handlers attach before the prompt")` (T7 sits immediately after T1, because it is T1's instrument)

| ID | Test (title as it must appear) | Asserts | Mutants it kills |
|---|---|---|---|
| **T1** | `pins the window's statement list: handlers attached before prompt(), one statement per regime (#450 ratchet)` | the **closed 12-entry window list** walked line by line — an unaccounted non-blank, non-comment line fails **at any indentation**; declared blocks are skipped to their declared closer; **each regime body** is read with `regimeBodyLines(windowSrc, "<the one statement>")` — located in **masked** text, the enclosing `try {` must **open on** that statement, the brace-matched block must be a `try/catch`, and its executable lines must be **exactly** that one statement; **each settle body's first two executable statements** are `markSettleEntry('success'\|'fault');` then `if (deadlineHandle) clearTimeout(deadlineHandle);`, from a **comment/string/regex-masked, brace-matched** read; and the attach precedes `session.prompt(` | M3, M4, M5, M6, M7, **M11**, **M15**, **M19**, **M21** (all measured red, `tsc` 0) |
| **T2** | `routes an async rejection through the deferred, clears the deadline and writes ONE terminal record (#450 async-rejection pin)` | `stopReason: "error"`, `agent.status === "failed"`, one terminal write, `subagent:failed`, fake-timer count 1 → 0, and no abort after advancing 2× the budget; `mocks.session.messages = []` | M1 (delete `onSettleFault`'s `clearTimeout`) |
| **T3** | `treats a returned non-thenable as a POST-start fault, never 'never issued' (#450)` | **(1)** non-thenable: spawn resolves with `running`; the run entry stays `running` (no `failPreStart`); `settle routing failed` logged; advancing the budget yields `errorCategory: "timeout"` and exactly one abort. **(2)** a native deferred whose own `then` accessor throws is still routed — its rejection yields `failed` with no timer advance. **(3) NEW r5** the same routing fault **with `setConsoleOutput(true)` and a throwing `console.error`**: the spawn must still RESOLVE with a `running` agent (pre-fix it rejects with `console error exploded`); `safeLog` is what keeps it so | M2 (merge the regimes), **M13** (revert to `runPromise.then(…)`), **M20** (route through `Promise.resolve`, which breaks the non-thenable contract) |
| **T4** | `normalises a non-Error value on BOTH regimes and rethrows the original throw (#450)` | (1) `throw null` → `.rejects.toBeNull()`, one terminal entry, `errorMessage: "null"`; (2) `reject(undefined)` → `failed`, `errorMessage: "undefined"`; (3) a git teardown throwing `null` → `.rejects.toThrow("original prompt")`, **3** run writes, terminal `failed`, `getCurrentBranch failed during cleanup` logged; (4) an unprintable thrown object → `.rejects.toBe(theObject)`, 3 writes, `errorMessage` = `unprintable thrown value`; (5) the **third `appendEntry` throws** → `.rejects.toBe(originalPrompt)`, `pre-start finalize failed` logged, `clearInflightRun` observed, registry empty; **(6) NEW r5** the same fault **with `setConsoleOutput(true)` and a throwing `console.warn`** → `.rejects.toBe(originalPrompt)` and `clearInflightRun` still observed (the log line is **not** asserted here: a throwing mirror loses the record, E35) | M9, M10, **M16**, **M17** |
| **T5** | `classifies a synchronous prompt throw ONCE — no settle body runs (#450 sentinel tripwire)` | no `Transcript completed:` line, no `subagent:failed`, still exactly 3 run writes, terminal `failed`, **`clearTimeout` called exactly once** (failPreStart's), **and ZERO `settle body entered` records** — with `mocks.session.messages = []`, `setLogCwd(env.baseDir)` and `setLogLevel("debug")` — **plus a positive control**: an immediately-resolving prompt in the same test produces exactly **one** record (`(success)`) | M8, **M12**, **M14** |
| **T6** | ``the caller observes `running` at its resume even when the prompt resolves immediately (#450 D4 decision)`` | `agent.status === "running"` at resume; no `await` between the pipeline's spawn await and `status: agent.status`; `completed` after one tick | red on the **baseline** (E8); this is the D4 pin, not a mutant |
| **T7** | `reads regex literals and FAILS CLOSED on what it cannot classify (#450 T1 instrument)` | a **14-case table** over the shipped lexer, each row naming its case in the message: 11 rows must return the TRUE body (`/[/*]/` and `/[//]/` **before** the declaration, `/[}]/` and `/[/*]/` **inside** it, an escaped slash, a template literal with `${ {x:"}"} }`, a block-comment decoy inside the body, a line comment carrying `}`, nested braces, a string carrying `/*`/`}`, a division) and 3 rows must REFUSE (a regex the heuristic cannot classify → `fail closed`; an unterminated regex → `must close on its line`; a declaration that exists only inside a comment → `declaration not found outside comments`) | none directly: this is the **instrument's** own test — it is what makes T1's greens trustworthy (E34) |

**Why T7 exists (r5, finding #4):** r4's ratchet-limits section admitted only "a regex literal inside the
settle bodies". The critic showed the limit was wider (`/[/*]/` **before** a declaration hid it entirely;
`/[}]/` inside **silently truncated** the returned body to `const r = /[`). Both are now impossible: the
masker classifies regex literals, and the brace match is verified against a construct boundary, so an
unreadable construct produces a **red pin**, not a short body.

**Fixture requirements discovered empirically (do not omit):**

- T2 and T5 must set `mocks.session.messages = []`. With an unreadable session projection the settle body
  throws at `captureAndReleaseSession`, the catch-all (`markTerminalBestEffort`) contains it, and the
  terminal **event/transcript** the tests look for never appears — the tripwire would pass for the wrong
  reason.
- T3's tampered-`then` case **cannot** use a `vi.fn()`: vitest's own mock instrumentation reads `.then`
  off a returned promise (`spy.js`: `if (returnValue instanceof Promise) returnValue.then(…)`), so the
  accessor would explode inside the harness. It injects a session whose `prompt` is a **plain function**
  (`mocks.createAgentSession.mockImplementationOnce(async () => ({ session: { ...mocks.session, prompt: () => tampered.promise } }))`)
  — which is also exactly the "injected session" shape the contract has to survive. **T3 case 3 uses the
  same shape** (a plain function returning `{}`) so the routing fault is reachable deterministically.
- T4 needs `setLogCwd(env.baseDir)` (cases 3 and 5 assert log lines) and restores the git mocks it
  overrides.
- T5 needs `setLogCwd(env.baseDir)` AND `setLogLevel("debug")`, and must restore `setLogLevel("info")` at
  the end. The marker is a `debug` record, which the default level filters out: without raising the level,
  "zero records" would hold no matter what the code did (a blind detector), and T5's positive control
  would fail. The level is module-global, hence the restore. Measured in E25: at the default level the
  marker writes **0 bytes** (the log file is not even created).
- T4 case 5 needs `import * as runRegistry from "../run-registry"` plus
  `vi.spyOn(runRegistry, "clearInflightRun")`; **T4 case 6 and T3 case 3 need the same spy plus
  `setConsoleOutput` imported from `../logging`**, and both must restore `setConsoleOutput(false)` **and**
  `mockRestore()` the console spy in the test body (a leaked throwing `console.warn` would poison the rest
  of the file — measured: the first draft did exactly that and made T4 look red for the wrong reason).
  Measured (E28): the spy observes exactly `failPreStart`'s own call — `persistRunRecord`'s internal
  `clearInflightRun` is a module-local call and is **not** counted, which is what makes M17 a valid mutant
  for the retire *step*.

### Must stay green — 11 (anchors re-measured at `481b852`; neither r4, r5 nor r6 moves any of them — the r6 delta is 0 test lines)

| File:line | Test |
|---|---|
| `session-manager.test.ts:982` | "arms the deadline before it returns, so a CALLER throw cannot unbounded the run (#453)" |
| `session-manager.test.ts:1007` | "clears a deadline armed before prompt() when the spawn throws synchronously (#448)" |
| `session-manager.test.ts:1649` | "review C: a throwing settle still tears the work branch down (catch-all)" |
| `session-manager.test.ts:2390` | "releases the ref via markTerminalBestEffort when a settle handler throws" |
| `session-manager.test.ts:2483` | "persists a session run entry with the agent id at spawn" |
| `session-manager.test.ts:2551` | "finalizes the run entry to failed when the session rejects" (`:2552` is its `mockRejectedValue` line) |
| `session-manager.test.ts:2657` | "finalizes the run entry to failed when prompt() throws synchronously (review F1)" |
| `background-session-persistence.test.ts:198` | "normalizes an instantly-firing timeout to the 30m default, not to ~1ms" |
| `background-session-persistence.test.ts:268` | "success: removes the per-run dir when the prompt completes" |
| `background-session-persistence.test.ts:286` | "timeout/abort: removes the dir when the deadline aborts the run" |
| `background-session-persistence.test.ts:752` | "markTerminalBestEffort: prunes the dir when a settle step throws" |

Plus the spawn-queue interleaving / immediate-`running` pins and the `sections builder` ratchet at `:303`
(`:309` is that test's `readFileSync` line).

All **179** tests in the two files (172 existing + 7 new) were **measured green** with the r5
implementation (E39) and again on the r6 tree with the contract comment in place (E47: `tsc` 0, `179
passed`), and the full suite's failing set is **identical** to the baseline's on the same corpus (E36 for
r5, **E47 for r6: added names 0**) — the marker, the D4 decision, the D5 normalisation, the `safeLog`
wrapper and the intrinsic routing are transparent to the existing suite, and so is the r6 comment.

### Ratchet limits, stated (r5: the lexer now classifies regex literals and fails closed)

- It is **text-based**, and it trusts the **declared list**, not indentation: a line enters the window only
  by matching a declared entry, **at any indentation**. Indentation is used for exactly one thing — finding
  a declared block's closer (the declared closer text, at the head's own indent) — so a smuggled top-level
  line can never be mistaken for a continuation, which was r2's bug (E17).
- **The four body pins are comment-, string- and regex-blind by construction.** `maskCommentsAndStrings`
  blanks block comments, line comments, string/template interiors **and regex-literal bodies** in place
  (offsets and newlines preserved), so a decoy cannot be located (M19, M21) and a brace inside a string,
  template or regex cannot unbalance the match. `blockBodyLines` then brace-matches from the block's `{` to
  its `}`, and **verifies the closer sits on a construct boundary** (followed on its line by nothing, `;`,
  `,`, `:`, `)`, or `catch`/`finally`/`else`) — a bound the truncated-body failure mode cannot pass
  (E34 case 12).
- **The regime pins are stronger than a text match**: the statement is located in masked text, the
  enclosing `try {` must **open on** it (no statement may precede the call or the routing), the matched
  block must be followed by `catch`, and its executable lines must be **exactly** the one statement. A
  comment or template decoy that spells the block is invisible; a real throw before the statement is
  named in the failure message (`found "if (Date.now() > 0) throw new Error("regime post-call fault");"
  before it`, E33).
- **Fail-closed, precisely** (T7, measured): (a) a `/` the heuristic calls a regex that does not close on
  its own line → `throws` (`must close on its line`); (b) a `}` the masker could not classify (a regex
  after `)`, where the heuristic says "division") → the boundary check `throws` (`fail closed`); (c) a
  declaration that exists only inside a comment → `throws` (`declaration not found outside comments`). A
  fail-closed case is a **red pin**, never a silent pass.
- **Its remaining limit:** the regex/division heuristic is the standard predecessor rule, not a parser. A
  regex literal in a position the rule misfiles as a division is **not masked** — and then either its body
  is harmless (no braces) or the boundary check refuses the block. That is fail-closed by measurement, not
  by hope; the case is in T7's table.
- **Out of the ratchet's scope, by construction:** the interior of every declared block — the marker
  helper, both settle-handler bodies beyond their first two statements, the `new Promise` executor, and
  each whole `try { … } catch { … }`. The two regime bodies **and** the two settle-body heads are
  re-asserted separately; statements deeper inside a handler body are caught behaviourally (M8/M12/M14 by
  T5, M15/M19 by the body pins), which is why T5 carries the entry marker rather than the ratchet.
- It is **text-based because it must be**: `typescript@7.0.2` ships the native compiler only —
  `ls node_modules/typescript/lib` → `getExePath.*`, `tsc.js`, `version.*`, **no `typescript.js`** — so
  there is no in-process AST API (E11). Same discipline as the existing `sections builder` ratchet.
- It pins the **statement text**, not line numbers, and not `runPromise.then(`; a renamed handler or a
  different routing spelling passes by amending the list — the forced decision the issue asks for.

## Critic findings → resolution (r1: nine, r2: five, r3: three, r4: five, r5: five — all accepted; twenty-seven rows, none dismissed)

| # | Round | Severity | Finding | Resolution |
|---|---|---|---|---|
| 1 | 1 | major | a returned thenable can resolve then throw | **D3 / Q2-R1′**: excluded by contract **and** by the routing's value check; residual stated, deadline backstop |
| 2 | 1 | major | a post-call throw enters `failPreStart` (prunes a live dir, releases a live branch lock) | **D2**: two regimes, boundary = the call |
| 3 | 1 | major | the extra hop is caller-visible (`completed` → `running`; `background-pipeline.ts:568`) | **D4 / Q1-S1**: accepted, explicit criterion, pipeline consequence named, pin (T6) red on the baseline |
| 4 | 1 | major | the ratchet permits throwing statements and pins only this spelling | **Q3-G1′ / T1**: closed window list, indentation-agnostic; named mutants M3–M7, M11, M15 must go red |
| 5 | 1 | major | the decided async-rejection pin was omitted | **T2** added (stopReason, agent status, one terminal write, deadline cleared; falsifier = M1) |
| 6 | 1 | major | F1's write count is not a tripwire | **D6/T5**: sentinel gone; r4's tripwire = **body-entry marker records** + transcript + event + `clearTimeout` count |
| 7 | 1 | major | sentinel rejection sequenced after two throwing steps; `throw null` breaks normalisation | **D5**: total normalisation, contained `failPreStart`, original throw preserved; M9/M10 red |
| 8 | 1 | minor | the retention claim is too broad | **D8**: narrowed to collectability of the deferred; roots named, measured (E7), out of scope |
| 9 | 1 | minor | `:2551` vs `:2552` | corrected in §Tests and E6 |
| 10 | 2 | major | the never-issued proof is narrower than claimed — a wrapper can start the method then throw | **D2.1 / Q2**: scoped to the unwrapped `async` SDK method + plain read + pure argument; probe E24 is the falsifier (row C1) |
| 11 | 2 | major | regime 2's log-and-continue does not bound a routing fault — a later rejection can terminate the host | **D2.3 / Q2-R1′ / D3**: intrinsic routing; unsupported values throw → log → deadline; Proxy residual named; E16 + M13 |
| 12 | 2 | major | the G1 ratchet misses a top-level statement indented four spaces | **Q3-G1′ / T1**: indentation-agnostic walk; **M11** measured red while r2's scan passed the same source (E17) |
| 13 | 2 | major | D5 overstates containment: `String(reason)` can throw and `cleanupWorkBranch` can throw a non-`Error` before the protected finalizer | **D5**: total `normalizeThrown`/`thrownMessage` + contained `failPreStart`; teardown catch sites normalised; T4 cases 3–4 (E18) |
| 14 | 2 | minor | T5's tripwire only sees M8 if the body reaches its writes | **D6/T5**: body-entry observable, M12 measured red (green under r2's T5 — E19) |
| **15** | **3** | **major** | **the body-entry tripwire is conditional on the timer handle, and the source pin is an unanchored regex** — the critic's `deadlineHandle = undefined; rejectSettled(err)` build and the block-comment decoy both passed T1+T5 (and `tsc`) | **D1/D6/T5 + T1 (r4 finding #1)**: `markSettleEntry(kind)` is the bodies' first statement at `debug`, independent of the handle; T5 asserts **zero** entry records **and a positive control**; T1 locates each declaration in **comment/string-masked** text and **brace-matches** the body, asserting `[0]` = marker. Both critic builds are named mutants: **M14** (red on T5's entry record with the `clearTimeout` count still 1) and **M15** (red on T1, green on T5 — T1 is the independent instrument). E26/E27 |
| **16** | **3** | **minor** | **the "no independent containment mutant" limit is too broad** — the finalizer catch IS behaviourally testable | **D5 honest limit + T4 case 5 (r4 finding #2)**: limit narrowed to the **teardown** catch; **M16** (delete the finalize catch) red at `append blew up`; **M17** (delete the retire step) red on the spy; **M18** (delete the teardown catch) measured **green** — the narrowed limit, stated. E26/E28 |
| **17** | **3** | **minor** | **the D2.1 scope did not reach the site** — the r3 site comment still said a synchronous throw "therefore means the callee was never entered" | **D2.1 / Acceptance 3 / execution sketch (r4 finding #3)**: the three preconditions are pasted into the REGIME 1 comment **and** `failPreStart`'s doc comment (exact text); Acceptance 3 qualified; E24's `live=true` probe is the falsifier and the wrapper shape is explicitly not claimed pre-start. E24 |
| **18** | **4** | **major** | **the regime-body checks still matched UNMASKED window text** — a marker-helper comment carrying the exact regime-2 `try` text, plus a real throw before the routing, passed T1 with `tsc` 0 | **T1 + `regimeBodyLines` (r5 finding #1)**: both regime bodies are read from masked text, must OPEN on their one statement, must be a `try/catch`, and must contain exactly it; the critic's build is **M19** and a **template-literal** variant is **M21** — both RED on r5, both GREEN on r4 (E33). Provenance probe E34 for the masker underneath |
| **19** | **4** | **major** | **intrinsic routing is not non-throwing for every native promise** — `PerformPromiseThen` performs a `SpeciesConstructor` read; a throwing `constructor` getter strands a later rejection and the host exits 1 (strict **and** default) | **D2.2/D2.3/D3/Acceptance 8 narrowed (r5 finding #2)**: the supported value is an *ordinary* native `Promise<void>` with a safe `constructor` lookup; the residual is named at the site, in D3 and in Acceptance 8; the **species-getter probe** is E32 (7 variants × 2 modes) and the containment-attempt mutant is **M20** (rejected on evidence). One line states why no containment exists: every attach path performs the same read |
| **20** | **4** | **major** | **a catch-path log can throw and replace the original error** — `logging.ts:158–160` calls the console mirror outside its file-write catch, so `setConsoleOutput(true)` + a throwing `console.warn` gave T4 `console blew up` instead of `original prompt` and skipped the retire | **D5.1 + `safeLog(write: () => void)` (r5 finding #3)**: one module-level helper, six catch-path call sites, thunk signature (a level-branching one trips the terminal-status structural guard — measured, E38). **T4 case 6** (warn level) and **T3 case 3** (error level) are the falsifiers: both RED on the r4 source, GREEN on r5 (E35). Global fix **#543**, out of scope |
| **21** | **4** | **minor** | **the lexer was weaker than admitted** — `/[/*]/` before a declaration hid it; `/[}]/` inside truncated the body to `const r = /[` | **T7 + a regex-aware, fail-closed masker (r5 finding #4)**: 14-case table, 11 must read the true body, 3 must refuse; the brace match is verified against a construct boundary, so truncation is a red pin. Measured E34 |
| **22** | **4** | **minor** | **evidence hygiene** — the saved mutant script used an undefined function for M4–M7 (`tsc=1`), and the r4 counts conflated a skipped test with failures | **§Mutants + §Evidence (r5 finding #5)**: the **compiling** script is preserved verbatim (§Appendix) and is the one the table cites; counts corrected everywhere to **69 failed / 1 skipped / 10 failed files / 31 failed suites** on the `/tmp` corpus (E36) and to the same-corpus full-suite comparison (**added: ∅**, E36/E39). Every mutant is run in ONE pass at the end (**M1–M21**, E38) |
| **23** | **5** | **major** | **the species contract is inconsistent in three places** — the site permits a safe `constructor` lookup but not a safe `Symbol.species` lookup; a throwing `Promise[Symbol.species]` strands a later rejection and the host exits 1; and "every other value throws" calls measured-**accepted** subclasses and cross-realm promises rejected | **One CONTRACT C450-R6 (r6 #1)**, used **word-for-word** at the site, in D3 and in Acceptance 8; covers `constructor` **and** `Symbol.species`; splits *UNSUPPORTED* into *necessarily rejected* (the intrinsic cannot attach) and *measured accepted, not relied on* (subclass, cross-realm); residual named with its falsifier (row **C3**). E44: `p.constructor === Promise` yet `routed=false`, `catch=Error: species getter exploded`, exit 1/1; subclass/cross-realm `routed=true`, exit 0/0 |
| **24** | **5** | **major** | **the test delta is over the flow gate and the sketch omits the declaration** — measured +910/−1 against an allowance of 514 for 197 net source lines (over by 395) | **G1′ kept; the declaration added (r6 #2)**: the r6 tree measures +253/−35 (net **218**; +21 is the contract comment) → allowance **556**, test net **909** → **over by 353**; the bare `Test budget: over-allowance — <reason>` line is a numbered sketch step (16) and a PR-body checklist line, with the one-paragraph rationale; Q3 records the rejected cheaper alternative and notes that its rejection is on quality, not on the budget. E43 |
| **25** | **5** | **major** | **Appendix A is not a reproducible gate** — absolute `/tmp` paths, 21 external Python patches, only M19/M21 inlined, and the expected label printed rather than derived | **§Appendix A replaced by a self-contained gate (r6 #3)**: 21 inline single-occurrence search/replace patches, `BASE` from the reader, verdict derived from `tsc` + the selection's exit code. Executed (E46: 21/21 applied, **20 RED, M18 GREEN, `tsc=0`**) — which exposed the no-op M18 patch the r5 gate had relied on |
| **26** | **5** | **minor** | **the coverage claim overstates** — "sites 1–3 are pinned by T4 case 6" is false: case 6 faults the finalizer (site 2); M18 stays green and the retire catch is unreachable | **Measured reachability matrix (r6 #4, D5.1 + §Risks)**: **site 2 behaviourally pinned**, **sites 1 and 3 construction-only**, site 6 pinned by T3 case 3 — and, measured while verifying it, **site 4 IS reached** by two existing catch-all tests (its containment unpinned). E45 also shows why r5's E42 could not see this: vitest prints a passing test's console output nowhere |
| **27** | **5** | **minor** | **E40's provenance is wrong** — it was carried as an r4-era entry although `safeLog` is new in r5 (+48/−18 between the r4 and r5 source trees) | **Corrected (r6 #5, E48)**: E40 is an **r5-era** entry measured on `/tmp/brl450-r5fresh` (its probe path is hard-coded there); the fresh run of the probe against the r6 tree is a separate statement (`SAFELOG_TOTAL=yes`, 7/7). The "subjects unchanged by r5" explanation is withdrawn |

## Risks

- **The D4 status change is real for pipeline callers.** Mitigated by the pin (T6) and by the
  no-consumer measurement (one read of `identity.status`). If a caller is found that branches on it, S1 is
  wrong and S2 (shape (c), ratchet-only) is the fallback — say so before implementing, not after.
- **The routing contract is exactly CONTRACT C450-R6, and it is narrower than r4 stated** (D2.3). For the
  SUPPORTED value — an ordinary native `Promise<void>` whose `constructor` **and** `Symbol.species` reads
  are both safe — the routing attaches and cannot strand a rejection. For a native promise whose
  **`constructor` read throws** (or yields a non-object), **or** whose `Symbol.species` read throws, the
  species step throws before the reaction is queued, the rejection stays unowned and the host exits 1
  (E32/E44). For a **Proxy-wrapped** promise the intrinsic refuses it and the underlying rejection is
  unowned. Both residuals are named in the contract and at the site; do not "fix" them by assimilating the
  value (`Promise.resolve`) — that records a live run as `completed` for a non-thenable return (Q2 row R3,
  **M20**) and contains neither residual (E44). **Do not call the measured-accepted subclass or cross-realm
  promise rejected** — they route (E44).
- **The never-issued proof is scoped — and written in the code** (D2.1). A wrapper around
  `session.prompt` (retry, decorator, an injected double that starts work) voids it; the site comments must
  be read as preconditions, and review must treat such a wrapper as a post-start fault. **A reviewer must
  not restate the proof without the three clauses** — that is finding #3 of round 3, and the reason the
  comment is pasted verbatim in D2.1.
- **Catch-path logging is contained locally, not globally** (D5.1, finding #3). `src/logging.ts` still
  calls the console mirror outside its file-write catch, so **any other** catch-path log in the codebase
  can still replace the error it reports; **#543** is the fix and is out of this unit. Within this unit the
  measured coverage is **site 2** (pinned by T4 case 6) and **site 6** (T3 case 3); **sites 1, 3 and 5 are
  construction-only** (0 file-marker hits, E45); **site 4 is reached** by two existing tests but neither
  makes the sink throw there, so its containment is unpinned too. A reviewer must not read the green of
  those tests as evidence for that containment — and must not re-quote E42's old "0 hits": that
  measurement used a `console.log` marker, which this harness never prints for a passing test (E45).
- **A throwing log sink also loses the record** (D5.1): the console mirror runs **before** the file write,
  so `safeLog` preserves the error and the later steps but not the log line. T4 case 6 therefore asserts
  the error and the retire, not the line. #543 is where that is fixed.
- **The window's readability.** The call now sits ~270 lines below the acceptance write. A reader must
  follow `settled.then(onSettled).catch(onSettleFault);` before the call. The regime comments and the
  ratchet are what carry it.
- **Regime 2 is a log-and-continue path for *unsupported* values.** If it is reached, the run is
  unmonitored until the deadline — deliberately, because every alternative destroys a live session's branch
  or dir. Do not "improve" it by calling `failPreStart` or by arming a second timer.
- **The T5 tripwire now rests on three invariants, each pinned**: (i) the settle body can run at all
  (`session.messages = []` fixture, so an entered body reaches no further and leaves only its record),
  (ii) the **marker is the first statement** of each body (T1's `[0]`), and (iii) the record is written at
  the level the test raises (`setLogLevel("debug")` + `setLogCwd`, with a **positive control** proving the
  detector fires). If a future edit moves the marker, T1 goes red before T5 becomes blind — the designed
  order. If a future edit changes the level, T5's positive control goes red.
- **The marker is a record, not a guard.** It changes nothing about the settle path (measured: 179/179 in
  the two files, full suite identical, E39) and writes nothing at the default level (E25). Do not "improve"
  it into a counter or a flag: a counter would need ownership and teardown (the very class of state the
  engineering bar asks about), and a flag would be a second state machine next to the deferred.
- **`failPreStart`'s containment limit is narrowed, and only the teardown catch is unmutated (D5).**
  **M16** and **M17** go red, so the finalize and registry-retire steps are pinned; **M18** (teardown catch
  deleted) is measured **green** and is the remaining defence in depth. A reviewer who wants the teardown
  catch gone must show `cleanupWorkBranch` cannot throw; a reviewer who wants `clearInflightRun`'s catch
  gone must show the retire step can throw (it cannot today — the function swallows its own errors).
- **The T1 lexer's remaining limit is a heuristic, not a parser** (regex/division). It is fail-closed by
  measurement (T7's three refuse cases), but a future author who adds a construct the heuristic misfiles
  will get a **red pin with a "fail closed" message**, not a false green — the message names the construct
  and says the masker cannot verify the block.
- **`safeLog` is a thunk, and that is load-bearing**: a level-branching signature (`safeLog('warn', …)`)
  trips `src/__tests__/terminal-status-consistency.test.ts` (the structural guard reads `level === 'error'`
  as a re-implemented status predicate and the full suite goes red — measured, E38). Do not "simplify" it
  back to a level argument without re-running that guard.
- **The test delta is over the flow gate, and the PR must say so.** Net 909 test lines against an
  allowance of 556 (net 218 source lines) — over by **353** (E43). `scripts/check-test-budget.mjs --flow`
  returns exit 1 and the merge gate blocks the PR unless the body carries a line-start
  `Test budget: over-allowance — <reason>` outside fences and blockquotes (measured: the bare line exits 0,
  the same line inside a fence exits 1). The declaration is a **step** in the execution sketch (step 16);
  the reason is the instrument, and Q3 records the cheaper alternative that was rejected and why. Do not
  fabricate the numbers in the declaration — re-run `--flow` on the branch and quote its line.
- **Four `(err as Error).message` sites remain** outside this unit — `stopAgent`, `steerAgent`, and two in
  the #453 deadline timer body (baseline `:1207`, `:1253`, `:2406`, `:2427`; the r5 `/tmp` copy's numbers
  are `:1258`, `:1304`, `:2481`, `:2507`). Same class (a `throw null` there throws inside a log line, and
  inside a timer body that would be an uncaught exception) but a different boundary; **flagged, not fixed**
  (surgical boundary). If the reviewer wants them in scope, they are four one-token edits plus one test
  each, and should be their own unit.
- **`err` narrowing** in `onSettleFault` (D5) is mechanical but touches a 150-line body: the implementer
  must not reorder statements while editing it — and must not move the new marker below the body's first
  line (T1 pins it).

## Non-goals

- Not shape (a) (`Promise.resolve().then(() => session.prompt(...))`), not a spawn-queue change, not a
  relocation of #439's containment, not a `background-pipeline.ts` change.
- Not a total fix for hostile return values: a Proxy-wrapped promise **and a native promise whose
  `constructor` or `Symbol.species` read throws** keep their process residual (CONTRACT C450-R6, E32/E44).
- Not a fix for the pre-start agent-record residue (D8) — separate unit, **#542**.
- **Not the global log-sink fix**: `src/logging.ts:158–160` (the console mirror outside the file-write catch)
  is **#543**. This unit contains its own catch-path calls with `safeLog` and does not touch `logging.ts`.
- Not a fix for the four out-of-scope `(err as Error).message` sites (§Risks).
- Not an observability feature: the marker is a `debug` record used by one test, not a new metric, and it
  is not wired into any dashboard, event or run record.
- Does not reopen #426 / #439 / #447 / #448 / #449 / #453 / #511, the deadline owner, the registry, the
  scratch/`.done` marker, or the containment's getter-backed `agent` read.
- No behaviour change for a successful run **except** D4's status at the caller's resume (decided, pinned)
  and one suppressed-by-default `debug` line.

## Delta budget

**Measured on the r6 intended tree** (`/tmp/brl450-r6/intended` — the repository + the two files, with the
r6 contract comment — built by this r6 patch and measured, not carried; E43/E47). `git diff --no-index
--numstat` against the repository:

| File | r6 vs r5 | Cumulative vs baseline (`481b852`) | Notes |
|---|---|---|---|
| `src/session-manager.ts` | **+21 / −0** (measured) | **+253 / −35** → net **218** (measured) | r6 adds only the CONTRACT C450-R6 comment (21 lines) inside the REGIME 2 block; no statement moves, and no anchor the Context table cites shifts (the comment sits below every anchor and above the routing) |
| `src/__tests__/session-manager.test.ts` | **0** | **+910 / −1** → net **909** (measured) | unchanged by r6 — the contract needs no test (a deliberate host exit is not assertable in-process), so the test delta is exactly r5's |
| other files | 0 | 0 | `diff -rq` against the repository: only these two files differ (E47) |

**The flow gate, computed with the repository's own rule** (E43; `scripts/lib/test-budget-flow.mjs`, the
module `check-test-budget.mjs --flow` uses):

```
test-flow: +909/+218 src (allowance 556) — over
```

`allowance = 120 + 2 × max(Δsource, 0) = 120 + 2 × 218 = 556`; `Δtest = 909`; **over by 353**. (For
reference, r5's numbers — without the r6 contract comment, which is where the 21 net source lines came
from — were 197 net source lines, allowance 514, over by 395. Both are stated so neither is stale, and the
formula makes the comment's own cost visible: every 1 net comment line buys 2 test lines of allowance.)

**Consequence: the PR MUST carry the declaration.** `scripts/check-test-budget.mjs --flow` exits **1** for
this delta, and the merge gate then requires a line-start declaration in the PR body — outside fences,
blockquotes and the generated pr-evidence block (measured, E43: the bare line exits 0, the same line inside
a fence exits 1, and `Test budget:` with a blank line after the colon exits 1). The exact shape (one line,
`—` is an em dash, `<reason>` must start on the same line):

```
Test budget: over-allowance — 909 test lines against a 556-line allowance (net 218 source lines, +253/−35): the 7 tests plus the masker/body-reader harness are the minimum sufficient pin for a structural guarantee.
```

**Why the 7 tests and the harness are the minimum sufficient pin** — the one-paragraph rationale the
declaration points at:

> The guarantee this unit buys is **structural**: no statement can be inserted between THE ATTACH
> and the prompt call at any indentation, and neither regime body nor either settle body's head can
> be faked. A structural guarantee needs an instrument that reads *executable* text rather than a
> text match — the masker plus three body readers (≈170–185 lines) with T1's pins (≈95–136) and T7's
> 14-row table (≈122) are that instrument — ≈390–440 of the 909 added test lines — and each piece
> was bought with a measured bypass (M15, M19 and M21 satisfy a text matcher; T7 exists because the
> lexer silently truncated the body on `/[}]/`, E34). The five behavioural tests (T2–T6, ≈418 lines)
> each pin a distinct failure mode with its own red mutant (M1–M21, E46). **No existing test is
> edited** — the 172-test set is untouched — and the full suite's failing set is unchanged on the
> same corpus (E47: added 0, removed 0). The cheaper alternative (an indentation-normalised window
> snapshot/hash) is rejected on quality grounds — opaque failure, comment-pinning, spelling-pinning
> — and its measured cost is in Q3, so the conductor can overrule it knowing exactly what it saves.

(Hunk arithmetic does not sum across revisions — adjacent edits merge — so both cumulative columns are
measured directly with `git diff --no-index --numstat`, not added. The per-test line figures in the
rationale are approximate: they are the line ranges from T1's `it(` to the next `it(` in the r6 file, and
the module-scope readers' range.)

## Execution sketch (implementer, in order)

1. **Read** `src/session-manager.ts:2460–2510` and `:2640–2700`; confirm the anchors (`:2472`, `:2474`,
   `:2490`, `:2501`, `:2651`) with
   `grep -n "run.acceptedAt = new Date\|persistRunRecord(pi, run\|runPromise = session.prompt(\|runPromise.then(\|}).catch((err: Error)" src/session-manager.ts`.
   If any moved, stop and re-derive — do not pattern-match this spec's line numbers.
2. **Add** the two total helpers (`normalizeThrown`, `thrownMessage`) at module level, before the first
   exported function. They are the only new module-level code besides step 3.
3. **Add `safeLog` immediately below them**, exactly as printed in D5.1 — a **thunk**, not a level
   argument (E38: the level form trips the terminal-status structural guard). Its doc comment is part of the
   patch.
4. **Harden `failPreStart`**: wrap `cleanupWorkBranch()`, `finalizeRunEntry(...)` and `clearInflightRun(id)`
   each in its own `try/catch`, log **through `safeLog(() => …)`** with `thrownMessage`, and **keep the
   `throw err` at every call site** — `failPreStart` must never throw now. Then **paste the D2.1 paragraph**
   into its doc comment, under the "PRUNING IS PROVABLY SAFE HERE" paragraph (D2.1, exact text).
5. **Normalise the teardown's own catch sites** (`getCurrentBranch`, `captureDiff`, `restoreHead`,
   `deleteBranch`) and the branch-setup refusal's `sanitizeErrorMessage(...)` to `thrownMessage(err)`.
   `grep -c "as Error).message" src/session-manager.ts` must go 12 → 5 (one of the five is a comment; the
   other four are the out-of-scope sites named in §Risks).
6. **Replace** the pre-start `try/catch` + `runPromise.then(() => {` header with D1's block: `let
   runPromise`, the two resolver declarations, `const settled`, **then `const markSettleEntry = (kind:
   'success' | 'fault'): void => { … }` exactly as printed in D1**, then `const onSettled = (): void => {`
   with `markSettleEntry('success');` as its first statement — the rest of the body stays byte-identical
   **except** its catch-all log call, which becomes `safeLog(() => log.error(…, { error:
   thrownMessage(err) }))`.
7. **Replace** `}).catch((err: Error) => {` with `};` + `const onSettleFault = (reason: unknown): void => {`
   whose **first** statement is `markSettleEntry('fault');`, then the `clearTimeout`, then
   `const err = normalizeThrown(reason);` as the first statement **inside** its `try`; its catch-all log
   call also becomes `safeLog(() => log.error(…))`.
8. **Replace** the trailing `});` with `};`, then insert THE ATTACH, then the **D2.1 REGIME 1 comment block
   verbatim** + regime 1 (with `thrownMessage` + `failPreStart` + `throw err`), then regime 2's comment
   **above** the `try` and the routing
   `void Promise.prototype.then.call(runPromise, resolveSettled, rejectSettled);` as its only statement,
   and regime 2's catch as `safeLog(() => log.error(…))`. Then `return agent;`.
   **The regime bodies must contain exactly one statement each** — T1 asserts it (a throw before the
   routing is M7/M19/M21).
   **Paste CONTRACT C450-R6 into regime 2's comment**, as printed in D2.3 — it is the block D3 and
   Acceptance 8 repeat, the same words in all three places; it replaces the two r5 paragraphs. It must sit
   **above** the routing's `try` and **below** every anchor the Context table cites, so no anchor moves.
9. **Typecheck**: `npx tsc --noEmit`. Expect no change in diagnostics; the definite-assignment on
   `runPromise` must still hold (regime 1's catch always throws).
10. **Run** `npx vitest run src/__tests__/session-manager.test.ts src/__tests__/background-session-persistence.test.ts`
    → **172 passed** before any test is added (the "no behavioural regression in the must-stay-green set"
    gate; if it is not 172, stop). **Then run `npx vitest run src/__tests__/terminal-status-consistency.test.ts`**
    → 33 passed (the structural guard; a `safeLog` with a level argument fails here, measured).
11. **Add the test-side helpers verbatim** from §Tests (`REGEX_PRECEDING_CHARS`, `REGEX_PRECEDING_WORDS`,
    `previousCodeChar`, `identifierBefore`, `maskCommentsAndStrings`, `blockBodyLines`, `handlerBodyLines`,
    `regimeBodyLines`) next to `readLog`, and the `import * as runRegistry` + `setLogLevel` +
    `setConsoleOutput` imports.
12. **Add the 7 tests** from §Tests verbatim in intent (T1–T7), with the fixture requirements — in
    particular T1's **executable-body pins** (`settledBody[0]`/`[1]`, `faultBody[0]`/`[1]`) **and** the two
    **`regimeBodyLines`** assertions replacing the old raw-text regexes, T5's `setLogCwd` +
    `setLogLevel("debug")` + **positive control** + level restore, T4 case 5 with the `clearInflightRun`
    spy, **T4 case 6** (throwing `console.warn`) and **T3 case 3** (throwing `console.error`, spawn must
    still resolve), and **T7**'s 14-case table. Run the same two files → **179 passed**. (Finding #4 is
    what T7 covers; finding #5 is the evidence rule for steps 14–16: the mutant gate is the
    **self-contained** one printed in §Appendix A, the suite counts are never added across corpora, and
    failures are compared **by normalized name** — never by arithmetic.)
13. **Fuzz the lexer yourself once** (T7 is the durable copy): add a temporary row for any regex/division
    construct you introduce near the window and confirm the pin either reads the true body or refuses. If
    it refuses, fix the construct or extend the classifier — never loosen the boundary check.
14. **Run the mutant gate** — §Appendix A, verbatim, `BASE` set to your working tree:
   `BASE=$PWD bash mutants-r6.sh`. **Every row must print `tsc=0` and `RED`, except M18, which must print
   `GREEN`** (the documented teardown limit). The verdict is derived from the two exit codes, never from a
   label. A `PATCH FAILED` line means your source text has drifted from this spec's — fix the source
   against the spec, never the patch, and re-run. Do not proceed past any other green mutant: a green
   mutant names a missing assertion, not a redundant test. The gate needs **no** `/tmp` state the
   proposer created — it builds its own work tree from `BASE` (E46 ran it that way).
15. **Run the full suite** and compare the failing set with the baseline **on the same corpus** (a `/tmp`
   copy for each; a tree that lacks `.development`/`.git` fails 10 extra tests in BOTH trees — compare
   sets, never raw counts). Acceptance: **0 new failures**. Measured for r6 (E47, two trees of the same
   corpus): base `3039 / 2969 / 69 failed / 1 skipped / 31 failed suites`, r6 `3046 / 2976 / 69 / 1 / 31`,
   **added 0, removed 0** by normalized name. (The full-corpus run in the repository, E36, is
   `3039 / 2979 / 59 / 1 / 6 / 23` vs `3046 / 2986 / 59 / 1 / 6 / 23` — the corpus, not the change, is why
   the absolute counts differ.)
16. **Declare the test budget, then write the PR body.** Run
   `node scripts/check-test-budget.mjs --flow --base dev --head <sha>` on your branch. It prints
   `+909/+218 src (allowance 556) — over` and exits **1** (re-derive if your contract comment changed the
   source net; each net source line buys 2 test lines of allowance). Put the declaration on its own line
   **outside** fences and blockquotes, in exactly this shape —

   ```
   Test budget: over-allowance — 909 test lines against a 556-line allowance (net 218 source lines, +253/−35): the 7 tests plus the masker/body-reader harness are the minimum sufficient pin for a structural guarantee.
   ```

   — then write the PR body with `## Design assumptions`, the D4 decision, and — because this unit is
   stateful — the answers below. Verify the line with
   `node scripts/check-test-budget.mjs --declaration <body-file>`: it prints the line and exits 0, while a
   fenced copy, or `Test budget:` with a blank line after the colon, exits 1 (E43).

### Design assumptions (paste into the PR body)

1. **State created:** one in-memory deferred per spawn (`settled` + two resolver bindings), in the spawn's
   scope; no disk, no env, no registry. Lifetime = the spawn call's scope. The entry marker creates **no
   state at all** — one `debug` log line, filtered out at the default level (measured 0 bytes, E25).
   `safeLog` creates **no** state: it is a `try { write() } catch {}` with no field, no cache, no flag
   (proved total for seven throwing thunks, E40; fresh run on the r6 tree, E48).
2. **Teardown:** normal paths — the routing settles it; the settle body runs once. Pre-start failure — it is
   left pending and becomes collectable when the scope is released (deadline already cleared by
   `failPreStart`). Crash between create and teardown: nothing on disk changes; the existing deadline/registry
   semantics are untouched.
3. **Concurrency:** one deferred per invocation, single writer (`resolveSettled`/`rejectSettled` called only
   by the regime-2 reaction). No shared state, no lock needed. The marker is re-entrant by construction (a
   pure log call), so two bodies entering cannot interleave anything. `safeLog` is re-entrant for the same
   reason.
4. **Missing/partial/unreadable state:** a value the intrinsic refuses (non-thenable, custom thenable,
   Proxy) → regime 2 logs, the deadline stays the bound (fail-closed on monitoring, fail-open on the
   process: the spawn still returns the agent). Two residuals are named, not papered over: a Proxy-wrapped
   promise, and a **native promise whose `constructor` or `Symbol.species` read throws** — for both the
   underlying rejection is
   unowned and the host's unhandled-rejection policy applies (E16c, E32/E44). A throwing **log sink** is the
   third "unreadable" input: contained by `safeLog` at every catch-path site in this unit (the process-wide
   fix is #543), and the record itself is lost when the mirror throws first (measured, E35).
5. **Evidence:** §Evidence E1–E49 — each claim has a command and its observed output, and each search
   carries its coverage. The full-suite comparison is **same-corpus** and set-based (E36 for r5, **E47**
   for r6); the `/tmp` trees' absolute counts (69 failed / 31 failed suites) differ from the full-corpus
   ones (59 / 23) because those trees lack `.git`, and they differ in **both** trees equally. The r6
   contract text is checked for three-place identity in E49.

### PR-body checklist (the implementation PR, in order)

1. `## Design assumptions` — the five answers above, unedited.
2. **The D4 decision** — one paragraph: the caller observes `running`, `identity.status` is deterministic,
   and the terminal record/event/wake are unchanged (S1, T6).
3. **The test-budget declaration**, as a **bare line** on its own line, outside fences and blockquotes
   (fenced here only so the spec can show it unbroken — in the PR body it must be one plain line):

   ```
   Test budget: over-allowance — 909 test lines against a 556-line allowance (net 218 source lines, +253/−35): the 7 tests plus the masker/body-reader harness are the minimum sufficient pin for a structural guarantee.
   ```

   Then `node scripts/check-test-budget.mjs --declaration <body-file>` → prints the line, exit 0 (E43).
   Re-run `--flow` first and quote **its** numbers if they differ.
4. **The mutant gate's output table** (Appendix A), including the one `GREEN` on M18 and a one-line
   statement of why it is green (the teardown catch is unreachable through the harness).
5. **The same-corpus full-suite comparison** (step 15) — the two JSON summaries and "added 0 / removed 0".
6. **The scope statement** — #542 (agent-record residue) and #543 (global log-sink fix) are out of scope,
   with the six `safeLog` sites inside it (D5.1).

## Evidence log

Expected signature stated **before** each probe; every search carries its coverage. E1–E14 are r2's
entries (carried; E3/E4/E5/E6/E13 re-measured in r3, E5 re-measured in r5 as E36/E39). E15–E23 are r3's.
E24–E31 are r4's. E32–E42 are r5's. **E43–E48 are r6's**, and every one of them was measured on a tree
this r6 patch built from the repository (`/tmp/brl450-r6/{intended,base}`, E47), not on the killed-and-
resumed r5 state. Where a row depends on r5-era state it says so and names the tree (E40 is corrected for
exactly that reason, E48). The r4-side halves of E33/E35/E37 are labelled as such and ran on the r4 tree.

| # | Claim | Expected (before) | Command / probe | Observed |
|---|---|---|---|---|
| **E1** | the hop is caller-visible: baseline `completed`, deferred `running` at the caller's resume | `baseline: atResume=completed`, `deferred: atResume=running`, both `afterTick=completed` | `/tmp/brl450-probes/status-hop.mjs`, then the same shape in the real harness | standalone: exactly that. Harness: base `PROBE_AT_RESUME=completed / AFTER_TICK=completed`; impl `PROBE_AT_RESUME=running / AFTER_TICK=completed` ✔ |
| **E2** | an abandoned pending promise + handler closures are collectable | `collected: ['closure-payload']` | `node --expose-gc /tmp/brl450-probes/abandon-gc.mjs` (`FinalizationRegistry`, 1 MB payload captured by the handler, 5 forced GCs) | `collected: [ 'closure-payload' ]` ✔ |
| **E3** | the SDK's `prompt` is `async` — and it is the **only** `prompt(` call in `src/` (the D2.1 clause (a) precondition) | 1 `async prompt(`; 1 `new AgentSession(`; the only *call* is `:2490` | `rg -n "async prompt\(" node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js` → **1 hit** `:1704`; `rg -n "new AgentSession\(" …/core/sdk.js` → **1 hit** `:304`; `grep -rn "\.prompt(" src --include=*.ts \| grep -v __tests__ \| wc -l` → **9** (8 comments + `session-manager.ts:2490`); `rg -n "prompt\(" …/core/agent-session.d.ts` → `:573 prompt(text: string, options?: PromptOptions): Promise<void>;` | exactly that ✔ (re-measured in r3) |
| **E4** | the design is behaviourally transparent to the existing suite | 172/172 green, no test edited | `vitest run src/__tests__/session-manager.test.ts src/__tests__/background-session-persistence.test.ts` in the `/tmp` copy | r4: **178 passed** = 172 existing + 6 new; r5: **179** = 172 + 7 (E39); no existing test edited ✔ |
| **E5** | full suite: zero new failures | same failing set in both; impl = baseline + 6 tests, all passing | `vitest run --reporter=json` in `/tmp/brl450-base` and the impl tree | base `3039 / 2969 passed`; r3 and r4 both `3045 / 2975` with an **IDENTICAL** failing set. **Counts corrected in r5 (finding #5): `69 failed / 1 skipped / 10 failed files / 31 failed suites`, not `70 / 10`** — see E36, which also adds the same-corpus comparison ✔ |
| **E6** | the 11 must-stay-green anchors | all 11 present; async-rejection title at `:2551`, not `:2552` | `grep -n "<title>"` per title over the two test files — **12 queries, 12 hits** | 11 titles at the cited lines; rejection title `:2551`; sections-builder ratchet `:303` ✔ (carried; test file untouched by r3/r4 additions) |
| **E7** | what the pre-start path roots (D8) | `getAgent` → `running`, `_sessionRef` set, disk record `running`, last run entry `failed` | probe test in `/tmp/brl450-probe2` | `GETAGENT=running`, `SESSIONREF=set`, `DISK_STATUS=running`, `LAST_RUN=failed`, `EVENTS=["subagent:created"]` ✔ |
| **E8** | the D4 pin is red on the baseline | `expected 'completed' to be 'running'` | T6 copied into `/tmp/brl450-base` and run alone | `AssertionError: expected 'completed' to be 'running'` ✔ |
| **E9** | the change is confined to the intended files | only `src/session-manager.ts` + the one test file differ from baseline | `diff -rq /tmp/brl450-base/src /tmp/brl450-r4/src` | two files (E30) ✔ |
| **E10** | every named mutant goes red | 10/10 (r2) → 13/13 (r3) → **18 cases (17 RED + M18 GREEN, r4)** → **21 cases (r5): 20 RED + M18 GREEN**, `tsc` 0 for all | `/tmp/brl450-r5-probes/mutants-final.sh` (ONE pass over a fresh copy per mutant; one `-t` selection each; `tsc --noEmit` recorded per case). **Correction (finding #5):** the r4 script this row used to cite (`/tmp/brl450-r4-probes/mutants5.sh`) patched M4–M7 with an **undefined** `maybeThrowFromFutureEdit()`, so those four were `tsc=1` — a mutant that does not compile proves nothing (E37). The compiling script is preserved verbatim in §Appendix | 20 RED + M18 GREEN, `tsc=0` everywhere (E38) ✔ |
| **E11** | no in-process AST API (why the ratchet is text-based) | only `tsc.js`/`getExePath`/`version` under `lib/`; `require('typescript/lib/typescript.js')` fails | `ls node_modules/typescript/lib`; `node -e "require('…/typescript/lib/typescript.js')"` | `getExePath.d.ts getExePath.js tsc.js version.cjs version.d.cts`; `MODULE_NOT_FOUND` ✔ |
| **E12** | the delta | src and test only | `git diff --no-index --numstat` on `<rev>/src/session-manager.ts` and the test file | r4 vs baseline **+196/−29** src, **+588/−1** test; r4 vs r3 **+54/−7** src, **+177/−9** test (E30) ✔ |
| **E13** | nothing branches on `identity.status` | exactly one read | `grep -n "identity\.status" src/*.ts src/__tests__/*.ts`; `grep -n "function buildMonitoringDegradedParagraph" -A3 src/notify-completion.ts` | one hit, `src/background-pipeline.ts:995`; the degraded paragraph takes `Pick<BackgroundAgentIdentity, "id" \| "label">` (`notify-completion.ts:374`) ✔ |
| **E14** | `wrapTask` is pure (argument evaluation cannot throw) | a single `String.replace` | `grep -n "export function wrapTask" -A8 src/prompt.ts` | `:67`, `task.replace(/<\/?task>/g, …)` ✔ |
| **E15** | critique r2 #1 falsifier: a getter/non-`async` wrapper can start the real method and then throw | `syncThrow=yes`, `live=true`, `settledLate=resolved` | `node /tmp/brl450-r3-probes/start-then-throw.mjs` | exactly that ✔ (re-run as E24) |
| **E16** | critique r2 #2 falsifier: a routing fault before a rejection handler attaches can terminate the host; the intrinsic contains the supported case | (a) `routing-fault.mjs` under `--unhandled-rejections=strict` → `routing catch` then **exit 1**; (b) `routing-contain.mjs` → intrinsic attaches anyway, process survives; (c) residual: a Proxy → `TypeError` + **exit 1** | `node --unhandled-rejections=strict …/routing-fault.mjs`; `node …/routing-fault.mjs` (default mode); `node --unhandled-rejections=strict …/routing-contain.mjs`; `node --unhandled-rejections=strict …/routing-residual.mjs` | (a) `routing catch: then lookup exploded` → `exit=1`; **default mode also `exit=1`**; (b) `tampered:catch=clean`, `nonThenable:catch=TypeError`, `thenable:catch=TypeError`, `tamperedSettled=later rejection`, `SURVIVED`, `exit=0`; (c) `sub settled: sub rejection`, `proxy catch: TypeError: Method Promise.prototype.then called on incompatible receiver`, `exit=1` ✔ |
| **E17** | critique r2 #3 falsifier: r2's indent-based scan misses a four-space top-level statement; the r3 walk does not | r2 scan: **pass**; r3 scan: **fail** naming the line; `tsc` exit 0 | M11 source in `/tmp/brl450-r3`; r2's scan verbatim on the same source; the r3 T1 | r2 scan `passed` (11 heads, mutant present); r3 scan `AssertionError: window line 262 must be the declared head…`; `tsc exit=0` ✔ (r4 re-measures M11 at E26) |
| **E18** | critique r2 #4 falsifiers: pre-fix a git teardown's `throw null` replaced the prompt error and an unstringable reason was replaced by the conversion error; post-fix both are preserved | pre-fix 2 failed; post-fix green | `vitest run … -t "critic cleanup"` in `/tmp/brl450-cleanup-probe`; r3 T4 cases 3–4 | pre-fix `…but got 'Cannot read properties of null (readi…'` and `expected Error: conversion failed to be { …(1) }`; post-fix green with `3` run writes; `grep -c "as Error).message"` **12 → 5** ✔ |
| **E19** | critique r2 #5 falsifier: r2's T5 passes M8 when the fault body dies before its writes; r3's count catches it | r2-shaped T5 on M12: **pass**; r3 T5: **fail** `expected 2 to be 1` | M12 in the r3 tree, T5 with and without the spy lines | without: `Tests 1 passed`; with: `expected 2 to be 1`; green: `1` ✔ |
| **E20** | all 13 r3 mutants still go red on the r4 tree, and only the intended files differ (**superseded by E38 for r5**) | 13/13 RED on r4; three new mutants RED; two files differ | `bash /tmp/brl450-r4crit-mutants.sh`; `diff -rq` base vs r4 | 16/16 RED in one run + M17 RED separately (E26/E28); `diff -rq` → exactly two files ✔ |
| **E21** | the r3 suite was green and the r3 full-suite failing set matched the baseline (**superseded by E39 for r5**) | 178 in the two files; 6 `#450` tests `passed` | `vitest run …` on `/tmp/brl450-r3`; JSON pass over the assertions | `Tests 178 passed`; all 6 `#450` tests `passed` ✔ (r4 re-measures at E29, r5 at E39) |
| **E22** | the intrinsic routing is the same function for the supported value (no hop) | `p.then === Promise.prototype.then` → `true`; both reactions run in the same tick | `node --input-type=module -e 'const p=(async()=>{})(); …'` | `p.then === Promise.prototype.then : true`; `reaction ticks intrinsic: [ 0 ] dot-then: [ 0 ]` ✔ |
| **E23** | the routing change is inert for the repo's fixtures | 0 custom thenable `prompt` fixtures | `grep -rn "session\.prompt\.mock" src/__tests__/*.ts \| wc -l` → **99**; `grep -rn "then:" src/__tests__/*.ts` → **0** | 99 native-promise mock assignments, no thenable fixture ✔ |
| **E24** | **finding #3 falsifier (re-run in r4)**: a wrapper that starts `prompt` and then throws leaves the session LIVE, so "synchronous throw ⇒ never entered" is not general — and the site comment must say so | `syncThrow=yes`, `live=true`, `settledLate=resolved`, exit 0 | `node /tmp/brl450-r3-probes/start-then-throw.mjs` | `syncThrow= yes:wrapper threw after starting the call`, `live= true`, `settledLate= resolved`, `EXIT=0` ✔ — the D2.1 scope is now pasted into the REGIME 1 comment and `failPreStart`'s doc comment (D2.1) |
| **E25** | **finding #1, neutrality**: the entry marker writes NOTHING at the default level and cannot throw; the marker is the only new sink | default level → the log file is **not created** (0 bytes) and `log.debug` does not throw | probe test in `/tmp/brl450-r4` (`createTempEnv` + `setLogCwd` + `createLogger("session-manager").debug(<marker>)`, then read `<baseDir>/.pi/subagent-logs/brl-subagent.log`), then deleted | `expect({bytes, hasMarker}).toEqual({bytes: 0, hasMarker: false})` → `1 passed`; `expect(() => log.debug(…)).not.toThrow()` → passed ✔. Coverage: `grep -rn "settle body entered" src/` → **2** hits (the marker at `session-manager.ts:2580`, T5's matcher) |
| **E26** | **r4 finding #1/#2, the mutants**: the two r3 critic builds and the containment falsifier all go RED on the r4 tree, with `tsc` exit 0 | M14 → T5 red on the **entry record** (count still 1); M15 → T1 red; M16 → T4 red with `append blew up`; M1–M13 unchanged red; M4–M7 **rewritten to compile** (`if (Date.now() > 0) throw …`) so `tsc=0` | `bash /tmp/brl450-r4crit-mutants.sh` — **the compiling script**, not the one saved at `/tmp/brl450-r4-probes/mutants5.sh` (E37 shows the saved one's `tsc=1`) | M14 `AssertionError: a settle body was ENTERED on the sync-throw path: expected 1 to be +0`; M15 `the fault body must open on its entry marker: expected 'if (false && deadlineHandle) clearTim…' to be "markSettleEntry('fault');"`; M16 `the ORIGINAL throw must survive a throwing terminal write: expected Error: append blew up to be Error: original prompt`; M1–M13 + M11 all red; **16/16 RED**, `tsc=0` for every case reported here ✔ |
| **E27** | **finding #1, instrument independence**: the block-comment decoy is invisible to the behavioural tripwire, so T1 is what kills it (not T5) | M15 × T5 → GREEN; M15 × T1 → RED | `/tmp/brl450-mut5` with `m15.py`, then `vitest run … -t "sentinel tripwire"` and `-t "ratchet"` | T5:`Tests 1 passed \| 138 skipped`; T1:`AssertionError: the fault body must open on its entry marker…` ✔ — the two instruments are independent, and the pre-r4 regex pin is exactly what the decoy satisfied |
| **E28** | **finding #2, the narrowed limit**: the finalize and retire steps are pinned by mutants; only the teardown catch survives | M17 → T4 red on the spy; M18 (teardown catch deleted) → T4 GREEN | `/tmp/brl450-mut5` with a `clearInflightRun`-deleted patch (M17) and a `cleanupWorkBranch`-containment-deleted patch (M18); `vitest run … -t "rethrows the original throw"` | M17 `AssertionError: the registry retire step must be ATTEMPTED: expected "clearInflightRun" to be called at least once`; M18 `Tests 1 passed \| 138 skipped` ✔ — and the spy sees ONLY `failPreStart`'s own call (`persistRunRecord`'s internal clear is module-local), which is why M17 is a valid step mutant |
| **E29** | **r4 suite state**: 178 in the two files; the full suite's failing set is unchanged from r3 | `Tests 178 passed`; full suite identical to r3's JSON | `vitest run src/__tests__/session-manager.test.ts src/__tests__/background-session-persistence.test.ts` and `vitest run --reporter=json --outputFile=/tmp/brl450-r4-full.json` on `/tmp/brl450-r4`; a JSON pass comparing the two files by normalized failing fullName | two files: `Tests 178 passed (178)`; full suite: r3 `3045 / 2975 / 69 failed / 1 skipped / 10 failed files / 31 failed suites`, r4 the **same** figures, **`identical failing set: True`**, and all 6 `#450` tests `passed`. **Correction (finding #5):** r4 wrote "70 failed / 10 failed files". The JSON says **69 failed + 1 skipped** (vitest prints them on one line, which is where the 70 came from), **10 failed files**, **31 failed suites**; `numFailedTests=69`, `numPendingTests=1`, `numSkippedTests` absent (E36). The *comparison* is what the acceptance depends on, and it is identical ✔ |
| **E30** | **the change is confined, and the delta is what the budget says** | two files differ; r4 vs r3 `+54/−7` src, `+177/−9` test | `diff -rq /tmp/brl450-base/src /tmp/brl450-r4/src`; `git diff --no-index --numstat` on the two files for base→r4 and r3→r4 | two files; base→r4 `+196/−29` src / `+588/−1` test; r3→r4 `+54/−7` src / `+177/−9` test ✔ |
| **E31** | **finding #1, the marker's position is pinned, not just present** | T1's `handlerBodyLines` returns the **brace-matched** body and asserts `[0]` = marker, `[1]` = deadline clear; a masked comment can never supply either | `vitest run … -t "ratchet"` on the green tree (pass) and on M15 (fail) — the same assertion, one variable | green: `Tests 1 passed`; M15: `AssertionError: the fault body must open on its entry marker: expected 'if (false && deadlineHandle) clearTim…' to be "markSettleEntry('fault');"` ✔. Coverage: `grep -n markSettleEntry src/session-manager.ts` → **3** hits (declaration `:2578`, `:2587` success, `:2740` fault); `grep -n "clearTimeout(" src/session-manager.ts` → **3** call sites (`:1985`, `:2588`, `:2741`) |
| **E32** | **finding #2** — `Promise.prototype.then` is not a pure internal-slot operation: it reads `constructor` (SpeciesConstructor), so some native promises strand their rejection | a native promise with a throwing `constructor` getter → routing throws, `routed=false`, later rejection unhandled, `exit=1` **in both modes**; `Promise.resolve(p)` throws the same way; `Promise.race([p])` routes but still exits 1; a **subclass** and a **cross-realm** promise route and exit 0 | `/tmp/brl450-r5-probes/species-variants.mjs <variant>` under `node --unhandled-rejections=strict` **and** `node` (default), 7 variants × 2 modes | **own throwing `constructor` getter** → `own-ctor-getter\|routed=false\|catch=Error: species lookup exploded`, exit **1/1**; **`Symbol.species` on the constructor** → `ctor-with-throwing-symbol-species\|routed=false\|catch=Error: symbol.species exploded`, exit **1/1**; **non-object `constructor`** (`42`) → `routed=false\|catch=TypeError: The .constructor property is not an object`, exit **1/1**; **subclass** → `routed=true`, exit **0/0**; **cross-realm** → `routed=true`, exit **0/0**; **containment `Promise.resolve`** → `routed=false\|catch=Error: species lookup exploded`, exit **1/1**; **containment `Promise.race`** → `routed=true`, exit **1/1**. Conclusion: **no containment exists** — every attach path performs the same read ✔ |
| **E33** | **finding #1** — the r4 regime pin matched unmasked text; the r5 pin cannot be satisfied by a decoy | r4 tree: T1 **passes** for both decoys (`tsc=0`). r5 tree: T1 **red** for both, naming the real throw | M19 (block-comment decoy inside the marker helper + a real `if (Date.now() > 0) throw` before the routing) and **M21** (the same expected text in a multi-line **template literal**) applied to `/tmp/brl450-r4` and to `/tmp/brl450-r5fresh`; `vitest run … -t "ratchet"` | r4+M19 `Tests 1 passed \| 138 skipped`, `tsc=0`; r4+M21 `Tests 1 passed`, `tsc=0`; r5+M19/r5+M21 both `AssertionError: the regime body must OPEN on its declared statement — found "if (Date.now() > 0) throw new Error("regime post-call fault");" before it`, `tsc=0` ✔ — **two independent decoys, four measurements** |
| **E34** | **finding #4** — the lexer's real behaviour, case by case, before and after | before: `/[/*]/` before the declaration → `declaration not found`; `/[}]/` inside → body truncated to `const r = /[`; after: 11 rows read the true body, 3 rows refuse | `/tmp/brl450-r5-probes/masker-table.mjs` (slices the SHIPPED helpers out of the test file, so it tests the shipped lexer) + T7 (the same 14 cases, durable) | 1 `/[/*]/` before decl → `["if (deadlineHandle) clearTimeout(deadlineHandle);"]`; 2 `/[//]/` before decl → same; 3 `/[}]/` inside → `[…, "const r = /[}]/;", "after();"]`; 4 `/[/*]/` inside → `[…, "const r = /[/*]/;", "after();"]`; 5 `const r = /a\/b/;` → `[…, "const r = /a\\/b/;", "after();"]`; 6 `` `a${ { x: "}" } }b` `` → `[…, "const s = `a${ { x: \"}\" } }b`;", "after();"]`; 7 block-comment decoy in body → `[…, "after();"]` (comment line dropped); 8 line comment with `}` → same; 9 nested braces → `[…, "const o = { a: { b: 1 } };", "after();"]`; 10 string `"/* } */"` → `[…, "const s = \"/* } */\";", "after();"]`; 11 division `total / 2` → `[…, "const h = total / 2;", "after();"]`; 12 regex after `)` → **REFUSED** `the closer found for … is followed by "]/.test(s);" on its own line — the masker cannot verify this block (fail closed)`; 13 unterminated regex → **REFUSED** `mask: cannot classify the "/" at offset 96 — a regex literal must close on its line`; 14 declaration only in a comment → **REFUSED** `declaration not found outside comments`. Regime reader on the real window: `regime1: ["runPromise = session.prompt(wrapTask(params.task));"]`, `regime2: ["void Promise.prototype.then.call(runPromise, resolveSettled, rejectSettled);"]` ✔ |
| **E35** | **finding #3** — a throwing log sink replaces the original error and skips the retire; `safeLog` prevents both, at **two levels** | r4 source: T4 case 6 → `expected Error: console blew up to be Error: original prompt`; T3 case 3 → `expected Error: console error exploded to not be an instance of Error`. r5 source: both green, retire attempted | `/tmp/brl450-r4src-check` (a copy of the full-corpus r5 tree with `src/session-manager.ts` reverted to r4) and `/tmp/brl450-r5fresh`; `vitest run … -t "rethrows the original throw"` and `-t "non-thenable"`; `setConsoleOutput(true)` + `vi.spyOn(console, "warn"\|"error").mockImplementation(() => { throw … })` | r4src: `Tests 1 failed` for both selections, messages above, `tsc=0`; r5: `Tests 1 passed` for both, `clearInflightRun` observed, registry empty ✔. **Note (measured):** the log LINE is not written when the console mirror throws — the mirror runs before the file write — so T4 case 6 asserts the error and the retire, not the record ✔ |
| **E36** | **finding #5** — the suite counts, on two corpora, and the acceptance is set equality | `/tmp` corpus: 3045 total / 2975 passed / **69 failed** / **1 skipped** / **10 failed files** / **31 failed suites**; full corpus: 3039→3046 total, **59 failed / 1 skipped / 6 failed files / 23 failed suites**, added names ∅ | `vitest run --reporter=json --outputFile=…` on `/tmp/brl450-{base,r3,r4}-full.json` and on `/tmp/brl450-{basefull,r5full}.json`; python pass extracting `numTotalTests/numPassedTests/numFailedTests/numPendingTests/numFailedTestSuites`, failed `testResults` files, and the set of failed `fullName`s | `/tmp` corpus (base, r3, r4): `3039 / 2969 / 69 / 1 / 10 files / 31 suites`, `3045 / 2975 / 69 / 1 / 10 / 31`, `3045 / 2975 / 69 / 1 / 10 / 31` — **all three sets identical**; full corpus: base `3039 / 2979 / 59 / 1 / 6 / 23`, r5 `3046 / 2986 / 59 / 1 / 6 / 23` — **added ∅, removed ∅**. The 10-test difference between corpora is corpus (no `.development`/`.git` in the `/tmp` trees) and appears in **both** trees ✔ |
| **E37** | **finding #5** — the saved r4 mutant script was not runnable evidence | the saved script's M4 shape → `error TS2304: Cannot find name 'maybeThrowFromFutureEdit'`, `tsc=1`; the compiling shape → `tsc=0` and red | M4 from `/tmp/brl450-r4-probes/mutants5.sh` (`maybeThrowFromFutureEdit();`) applied to `/tmp/brl450-r4`; the same mutant with `if (Date.now() > 0) throw new Error('hidden fault');` (the r4crit script) | saved shape: `src/session-manager.ts(2554,3): error TS2304: Cannot find name 'maybeThrowFromFutureEdit'.` → `tsc=1`; compiling shape: M4–M7 `tsc=0`, all four RED (E38) ✔ |
| **E38** | **findings #1–#5** — the whole mutant set in ONE pass on the r5 tree | 21 cases: **20 RED, M18 GREEN**, `tsc=0` for every case | `bash /tmp/brl450-r5-probes/mutants-final.sh` (base `/tmp/brl450-r5fresh`; each mutant patches a fresh `src/`; one `-t` selection; `tsc --noEmit` recorded) | M1–M17 RED, **M18 GREEN** (the documented limit), **M19 RED**, **M20 RED**, **M21 RED**; `tsc=0` on all 21 — one table in §Mutants. Separately: a level-branching `safeLog('warn', …)` trips `terminal-status-consistency.test.ts` with `src/session-manager.ts:143 [comparison:error] level === 'error'`; the thunk form passes **33/33** ✔ |
| **E39** | **the r5 suite state** | `tsc` 0; **179 passed** in the two files; 7 `#450` tests; the structural guard 33/33; full suite set-identical to the baseline | `tsc --noEmit`; `vitest run src/__tests__/session-manager.test.ts src/__tests__/background-session-persistence.test.ts`; `-t "#450"`; `vitest run src/__tests__/terminal-status-consistency.test.ts`; full suite JSON (E36) | `tsc=0`; `Test Files 2 passed`, `Tests 179 passed (179)`; `Tests 7 passed \| 133 skipped (140)` for `-t "#450"`; `Tests 33 passed (33)`; full suite added ∅ (E36) ✔ |
| **E40** | **finding #2/#3 (r5) — provenance CORRECTED in r6 #5** — `safeLog` cannot itself throw, and the console mirror really is the leak | 3/3 levels escape `log.*` when their `console.*` throws; the healthy sink does not; `safeLog` never throws for seven throwing thunks | `/tmp/safelog-probe.mjs` (slices the **shipped** `safeLog` text out of the source and calls it) — **its path is hard-coded to the r5 tree, `/tmp/brl450-r5fresh`** — and a temporary vitest file (`setConsoleOutput(true)` + a spy per level, deleted after the run) | log levels: `level=error → console.error throwing escapes log.error`; `level=warn → console.warn … escapes log.warn`; `level=debug → console.log … escapes log.debug`; control (healthy sink) does not throw — `Tests 4 passed`; `safeLog` with `Error`/`null`/`undefined`/unprintable/Proxy/hostile-object thunks + a healthy thunk → `SAFELOG_TOTAL=yes` (7/7) ✔. **r6 correction:** this is an **r5-era** entry, not a carried r4 one — `safeLog` does not exist on the r4 tree (`grep -c "function safeLog"` → **0**; the r4→r5 diff is **+48/−18**, E48). The fresh r6 run of the `safeLog` half is E48; the three-level half was **not** re-run in r6 (stated in §did not verify). |
| **E41** | **the artifact is reproducible from the repository, and confined to two files** | a fresh copy of the repository + the two r5 files → `diff -rq` shows exactly those two; `tsc` 0; 179/179 | `rsync -a --exclude node_modules <repo>/ /tmp/brl450-r5full/` then copy the two files; `diff -rq <repo>/src /tmp/brl450-r5full/src`; `tsc --noEmit`; the two-file vitest run | exactly two files differ (`src/session-manager.ts`, `src/__tests__/session-manager.test.ts`); `tsc=0`; `Tests 179 passed (179)` ✔. Delta on that tree: `git diff --no-index --numstat` → r4→r5 **+48/−18** src, **+353/−31** test; base→r5 **+232/−35** src, **+910/−1** test |
| **E42** | **the limit that remains** — the settle catch-alls' `safeLog` has no behavioural mutant | neither existing catch-all test reaches the catch-all's log line | `/tmp/brl450-r4-catchline2`: each catch-all log line replaced by a `console.log("CATCHALL-LOG-REACHED")` marker; `vitest run … -t "releases the ref via markTerminalBestEffort"` and `-t "throwing settle still tears the work branch down"` | marker printed **0** times for both tests (and both still pass) — which r5 read as "neither test routes through those lines". **r6 correction (E45): this instrument is blind** — vitest prints a *passing* test's console output nowhere (control in E45), so "0 times" is uninformative. A file-write marker at the same two sites shows **site 4 reached once by each of the two tests** (and site 5 still 0). The *containment* is still unpinned at site 4 (neither test makes the sink throw there), but the reachability claim is withdrawn. Superseded by E45 ✔ |
| **E43** | **finding #2** — the r6 delta, the flow verdict, and the declaration the gate requires | source net **218** → allowance **556**; test net **909** → **over**; the bare declaration exits 0, a fenced one exits 1 | `git diff --no-index --numstat` on the two files (repository → `/tmp/brl450-r6/intended`); `computeFlow`/`formatFlowLine` from `scripts/lib/test-budget-flow.mjs` fed the measured numstat; `node scripts/check-test-budget.mjs --declaration` on three body files | numstat `253 35` and `910 1`; `test-flow: +909/+218 src (allowance 556) — over`; `[{"name":"src","source":218,"test":909,"allowance":556,"verdict":"over"}]`; declaration line → printed + exit **0**; the same line inside a fence → exit **1**; `Test budget:` followed by a blank line → exit **1** ✔ (r5's figures, without the contract comment: net 197, allowance 514, over by 395) |
| **E44** | **finding #1** — the species read is a **second** throw point, and the measured-accepted values must not be called rejected | `p.constructor === Promise` → `true` yet `routed=false`, `catch=Error: species getter exploded`, exit **1/1**; subclass and cross-realm → `routed=true`, exit **0/0**; four attach paths all end at the same read | `/tmp/brl450-r6-probes/species-contract.mjs <variant>` under `node` (default) and `node --unhandled-rejections=strict`, 7 variants × 2 modes; `/tmp/brl450-r6-probes/species-attach-paths.mjs <path>`, 4 paths × 2 modes | **intrinsic-species-throws** → `p.constructor === Promise -> true`, `routed=false \| catch=Error: species getter exploded`, exit **1/1**; **ordinary** → `routed=true`, exit 0/0; **subclass** → `routed=true`, exit **0/0**; **cross-realm** → `routed=true`, exit **0/0**; **non-thenable `{}`** → `routed=false \| TypeError: Method Promise.prototype.then called on incompatible receiver`, exit 0/0 (nothing to strand); **custom thenable** → same TypeError, exit 0/0; **Proxy of a promise** → `routed=false \| TypeError…`, exit **1/1** (underlying rejection unowned). Attach paths against the intrinsic-species throw: `intrinsic`, `resolve`, `race` → `attached=no \| caught=Error: species getter exploded`, exit **1**; `await` → `attached=yes` yet exit **1** — so no attach path contains it ✔ |
| **E45** | **finding #4** — which `safeLog` sites are reached, and why r5's instrument could not see it | six file-write markers: T4 → **site 2** only; T3 → **site 6**; T5/T2 → none; the two catch-all tests → **site 4**; sites 1, 3, 5 → never. Control: a `console.log` line is printed by a **failing** test and by nothing when the test passes | a scratch copy of the r6 tree (`/tmp/brl450-r6/sites`) with `try { writeFileSync('/tmp/brl450-r6/sites-reached.log', 'S<n>\n', { flag: 'a' }); } catch {}` inserted before each `safeLog(...)`; `vitest run … -t "<selection>"` per test, then `sort \| uniq -c` over the log; the control is a two-line test file run twice (failing, then passing) | `rethrows the original throw` (T4) → `2 S2`; `non-thenable` (T3) → `2 S6`; `sentinel tripwire` (T5) → ∅; `async-rejection pin` (T2) → ∅; `review C: a throwing settle…` → `1 S4`; `releases the ref via markTerminalBestEffort…` → `1 S4`. Control: failing test prints `stdout \| … CONTROL-CONSOLE-LOG-VISIBLE`, passing test prints **no** stdout block ✔ — so E42's "0 times" was an artifact, and site 4 is reached |
| **E46** | **finding #3** — the mutant gate is self-contained, and the r5 stored M18 patch was a no-op | all 21 inline patches apply (`count == 1`); `tsc=0` on every case; **20 RED, M18 GREEN**; M18's corrected patch (which really deletes the teardown catch) still GREEN | `BASE=<tree> bash <the script extracted from §Appendix A>` — run twice: once on `/tmp/brl450-r6/intended`, then again **as extracted from this spec** on `/tmp/brl450-r6/fresh` (a *new* copy of the repository + the two files, with a fresh `WORK`, i.e. without any tree the earlier runs used). The script links `BASE/node_modules` into `WORK` and exits 2 if the toolchain does not resolve | `PATCH FAILED` lines: **none** (21/21 applied); `tsc=0` everywhere; M1–M17, M19–M21 `RED` (vitest exit 1), M18 `GREEN` (`Tests 1 passed \| 139 skipped (140)`). Messages reproduced include M3 `window line 314 is not the declared statement…`, M6/M7 `the regime body must OPEN on its declared statement — found "if (Date.now() > 0) throw…"`, M14 `a settle body was ENTERED on the sync-throw path: expected 1 to be +0`, M16 `expected Error: append blew up to be Error: original prompt`, M17 `expected "clearInflightRun" to be called at least once`, M19/M21 the M6/M7 message with `"regime post-call fault"`, M20 `expected '' to contain 'settle routing failed'`. **M18 defect found while converting the r5 patches:** `/tmp/brl450-r5-mutscripts/m18.py` ends with `open('m18.py','w').write(...)` — it writes the patched *source text* into its own file and never touches `session-manager.ts`, so r5's "M18 GREEN" measured the **unmutated** tree. The r6 patch writes to the source; the result is still GREEN, so the documented limit stands on real evidence for the first time. **Falsifier for finding #3 executed:** the script extracted from Appendix A ran on the fresh tree to the same result (`RED 20 / GREEN 1`, `tsc=0`) ✔ |
| **E47** | **the r6 tree is green, confined to two files, and full-suite-identical on the same corpus** | `tsc` 0; 179/179 in the two files; `diff -rq` → exactly two files; full suite: added failing names **0** | `tsc --noEmit` and `vitest run src/__tests__/session-manager.test.ts src/__tests__/background-session-persistence.test.ts` on `/tmp/brl450-r6/intended`; `diff -rq <repo>/src /tmp/brl450-r6/intended/src`; `vitest run --reporter=json` on `/tmp/brl450-r6/{base,intended}` (both trees built from the repository **without `.git`**, so the corpus is identical), then a Python pass over `testResults[].assertionResults[]` comparing `(basename(file), fullName)` pairs | `tsc=0`; `Test Files 2 passed`, `Tests 179 passed (179)`; two files differ (`src/session-manager.ts`, `src/__tests__/session-manager.test.ts`); base `3039 / 2969 / 69 failed / 1 skipped / 31 failed suites`, r6 `3046 / 2976 / 69 / 1 / 31` — **added 0, removed 0** ✔ |
| **E48** | **finding #5** — E40's provenance, and a fresh `safeLog` run on the r6 tree | E40 cannot be an r4-carried entry: `safeLog` does not exist on the r4 tree; the fresh r6 run of the probe returns `SAFELOG_TOTAL=yes` | `git diff --no-index --numstat /tmp/brl450-r4/src/session-manager.ts /tmp/brl450-r5fresh/src/session-manager.ts`; `grep -c "function safeLog"` on both; `node /tmp/brl450-r6-probes/safelog-probe.mjs` (the r5 probe with its path repointed at `/tmp/brl450-r6/intended`) | numstat **+48/−18**; `function safeLog` count **0 (r4) / 1 (r5)**; fresh r6 probe: `ok Error thunk`, `ok null throw`, `ok undefined throw`, `ok unprintable object throw`, `ok proxy that throws on every trap`, `ok thunk that throws a throwing object literal`, `ok healthy thunk` → **`SAFELOG_TOTAL=yes` (7/7)** ✔ — a **separate statement** from anything about the killed r5 attempt |
| **E49** | **finding #1 (the "same words" requirement)** — the contract is textually identical in its three places, and to the shipped site comment | the three normalised texts are equal (1492 chars each) and equal to the r6 tree's comment; the r5 tree carries **no** such text at all | a Python pass that strips the `//`-and-`>` markers from each of the three blocks in this file, collapses whitespace, extracts the same span from `/tmp/brl450-r6/intended/src/session-manager.ts`, and compares; plus `grep -c "constructor\|species" /tmp/brl450-r5fresh/src/session-manager.ts` | `quote blocks: 3 identical: True`; `quote == tree comment: True`; `spec printed site block == quote: True` ✔ — formatting (markers, wrapping) differs, no word does. **And a provenance finding the r5 round missed:** the r5 tree its own E41 calls the artifact has **0** `constructor`/`species` lines — r5's "copy verbatim" block was never pasted, so the r5 gates measured a tree without it; r6 prints the block **and** measured a tree carrying it (E47) |

> **Probe hygiene note (r5/r6).** Two scratch-tree defects were caught and fixed rather than reported.
> (1) The r5 tree `/tmp/brl450-r5test-on-r4` was built with a `node_modules` symlink whose `.bin` did not
> resolve (`tsc` → 127, hundreds of spurious `TS2591 Cannot find name 'node:fs'`); it was discarded and the
> comparison re-run in a copied tree (`/tmp/brl450-r4src-check`, E35). (2) The **first r6 run of the mutant
> gate** hit the same class: `WORK` is populated with `rsync --exclude node_modules`, so with no explicit
> link every one of the 21 cases printed `tsc=127 \| vitest=127 \| COMPILE-FAIL` — an all-red table that
> proves nothing (a green-looking table would have been no better). The gate now links
> `BASE/node_modules` and **exits 2** if `vitest`/`tsc` do not resolve (Appendix A), and E46 is the run of
> the corrected script. Also: every full-suite comparison is **same-corpus** (both trees carry the
> repository's whole corpus; r6's pair both omit `.git`) and is never compared arithmetically across corpora
> (E36/E47).

## Mutants

Each patches a fresh copy of the **r6 tree** and names the selection that must kill it. **All 21 are run in
ONE pass** by the **self-contained gate in §Appendix A** (`BASE=$PWD bash mutants-r6.sh`, E46): the patches
are inline, the verdict is derived (`tsc` 0 + selection exit 1 ⇒ RED), and no proposer `/tmp` state is
needed. **`tsc --noEmit` exit 0** is recorded for every case — a mutant that does not compile proves
nothing, which is why M4–M7 are spelled with a compiling statement
(`if (Date.now() > 0) throw new Error('hidden fault');`) and not with the undefined
`maybeThrowFromFutureEdit()` the r4 script had saved (E37). Measured on the r6 tree: **21/21 patches
applied, `tsc=0` everywhere, 20 RED, M18 GREEN**. The messages quoted below are the r6 gate's own output;
only M3's window line number moved (310 → **314**, because the contract comment sits below the attach and
above the routing).

| Mutant | Edit | Test it must kill | Measured (red) |
|---|---|---|---|
| M1 | delete `onSettleFault`'s `if (deadlineHandle) clearTimeout(deadlineHandle);` | T2 | `expected 1 to be +0` (deadline cleared 1 → 0), `tsc` 0 |
| M2 | move the routing into regime 1's `try`, delete regime 2 | T3 | `TypeError: Method Promise.prototype.then called on incompatible receiver #<Object>` + `Tests 1 failed` — the post-start fault is now caught by regime 1, so `failPreStart` runs and **the spawn rejects** instead of resolving `running`; `tsc` 0 |
| M3 | move THE ATTACH below the routing | T1 | `window line 314 is not the declared statement: expected 'try {' to be 'settled.then(onSettled).catch(onSettl…'`, `tsc` 0 |
| M4 | insert `if (Date.now() > 0) throw new Error("hidden fault");` before `let runPromise` | T1 | `window line 26 is not the declared statement: expected 'if (Date.now() > 0) throw new Error("…' to be 'let runPromise: Promise<unknown>;'`, `tsc` 0 |
| M5 | insert it between THE ATTACH and regime 1 | T1 | `window line 289 must be the declared head: expected 'if (Date.now() > 0) throw new Error("…' to be 'try {'`, `tsc` 0 |
| M6 | insert it inside regime 1, before the call | T1 (the **regime pin**) | `AssertionError: the regime body must OPEN on its declared statement — found "if (Date.now() > 0) throw new Error('hidden fault');" before it`, `tsc` 0 |
| M7 | insert it inside regime 2, before the routing | T1 (the **regime pin**) | `AssertionError: the regime body must OPEN on its declared statement — found "if (Date.now() > 0) throw new Error('hidden fault');" before it`, `tsc` 0 |
| M8 | add `rejectSettled(err);` after `failPreStart(...)` | T5 | `expected true to be false` (the completion transcript line appears), `tsc` 0 |
| M9 | revert regime 1's message to `(err as Error).message` | T4 | `expected TypeError: Cannot read properties of null… to be null`, `tsc` 0 |
| M10 | revert the fault body's binding to `reason as Error` | T4 | `expected 'Subagent aborted by user' to be 'undefined'`, `tsc` 0 |
| M11 | insert `    if (Date.now() > 0) throw new Error("hidden fault");` (four-space indent, top level) after THE ATTACH | T1 | `window line 288 must be the declared head: expected 'if (Date.now() > 0) throw new Error("…' to be 'try {'` — **and r2's scan passed the same source** (E17), `tsc` 0 |
| M12 | M8 **plus** a throw as the fault body's first statement **after** the marker/clear | T5 | `expected 2 to be 1` (the `clearTimeout` count) — **r2's T5 passed this** (E19), `tsc` 0 |
| M13 | revert the routing to `runPromise.then(resolveSettled, rejectSettled);` | T3 | `AssertionError: expected 'running' to be 'failed'` — the tampered `then` accessor throws, no handler attaches, the rejection is unowned and the run never settles; `tsc` 0 |
| **M14** | **the critic's conditional-handle build (finding #1)**: `deadlineHandle = undefined; rejectSettled(err);` after `failPreStart(...)`, **plus** a throw as the first statement inside the fault body's `try` (after the marker and the clear) — so the body is entered, dies immediately, and the `clearTimeout` count stays **1** | **T5** (the entry-record assertion) | `AssertionError: a settle body was ENTERED on the sync-throw path: expected 1 to be +0` — **with the `clearTimeout` count assertion still passing at 1**, i.e. exactly the blindness r3 had (`tsc` 0) |
| **M15** | **the critic's block-comment decoy (finding #1)**: the real fault body opens on `if (false && deadlineHandle) clearTimeout(deadlineHandle);` (count stays 1) and dies, while a **block comment** spells `const onSettleFault = … markSettleEntry('fault'); …` | **T1** (the executable-body pin) — T5 is blind by construction | `AssertionError: the fault body must open on its entry marker: expected 'if (false && deadlineHandle) clearTim…' to be "markSettleEntry('fault');"`, `tsc` 0 — and M15 × T5 = `Tests 1 passed` (E27) |
| **M16** | **the containment falsifier (finding #2)**: delete **only** `failPreStart`'s `try/catch` around `finalizeRunEntry` | **T4 case 5** | `AssertionError: the ORIGINAL throw must survive a throwing terminal write: expected Error: append blew up to be Error: original prompt`, `tsc` 0 |
| **M17** | **the retire-step falsifier (finding #2)**: delete the whole `clearInflightRun(id)` *step* from `failPreStart` | **T4 case 5** (the spy assertion) | `AssertionError: the registry retire step must be ATTEMPTED: expected "clearInflightRun" to be called at least once`, `tsc` 0 |
| **M18** | **the narrowed honest limit (finding #2, corrected r6 #3)**: delete `failPreStart`'s `try/catch` around `cleanupWorkBranch()` | **none — measured GREEN, by design** | `Tests 1 passed \| 139 skipped (140)`, `tsc` 0 — the teardown's own catch sites are total, so no harness fault reaches it; this is the *only* remaining defence-in-depth step (D5). **r6 correction:** the r5 stored patch wrote its output to its own file and never mutated the source (E46), so r5's GREEN measured the unchanged tree; this row is the first real measurement of the deleted catch, and it is still GREEN |
| **C1** (contract falsifier, not a source mutant) | wrap the callee: start `session.prompt`, then throw (E24's shape) | D2.1 | no test can see this — it is a **contract** falsifier: the probe prints `live: true`, which voids the never-issued proof for that call shape. Recorded so a future wrapper is a review stop, not a silent regression — and so nobody restates the proof without the three clauses (finding #3) |
| **M19** (r5, finding #1) | **the critic's regime decoy**: a block comment inside the marker helper spells `try {` + the routing text + `} catch`, and the REAL regime 2 throws (`if (Date.now() > 0) throw new Error("regime post-call fault");`) before the routing | **T1** | `AssertionError: the regime body must OPEN on its declared statement — found "if (Date.now() > 0) throw new Error("regime post-call fault");" before it`, `tsc` 0. **On the r4 tree the same source PASSES T1** (`Tests 1 passed \| 138 skipped`) — that is the finding (E33) |
| **M20** (r5, finding #2) | **the containment ATTEMPT**: `void Promise.resolve(runPromise).then(resolveSettled, rejectSettled);` — own the value instead of using the intrinsic | **T3** (case 1) | `AssertionError: expected '' to contain 'settle routing failed'` — `Promise.resolve({})` **resolves**, so the success body runs and the non-thenable contract is broken; and for the species case it changes nothing (`Promise.resolve` throws the same read, E32), `tsc` 0 |
| **M21** (r5, finding #1) | **the second decoy**: the same expected regime-2 text in a **multi-line template literal** (`void \`try { … } catch\`;`) inside the marker helper, plus the real throw before the routing | **T1** | identical message to M19, `tsc` 0; **GREEN on the r4 tree** (`Tests 1 passed`) — so the r4 pin was satisfiable by *two* independent decoy shapes, not just the block comment (E33) |
| **C2** (contract falsifier, not a source mutant) | hand the routing a native promise whose `constructor` getter throws (E32's shape) | D2.3/D3 | no test can see this either: asserting a deliberate host exit is not expressible in vitest, and any in-process handler would defeat the measurement. The probe is the falsifier: `routed=false`, `exit=1` in both modes, and **every** containment attempt behaves the same (E32) |
| **C3** (contract falsifier, not a source mutant — new r6 #1) | hand the routing a native promise whose `constructor` **is the intrinsic `Promise`** while `Promise[Symbol.species]` is a throwing getter (E44's shape) | CONTRACT C450-R6 (D2.3/D3/Acceptance 8) | no test can see it: the routing catch is unreachable in-process because the failure happens *before* the reaction is queued, and the process exit is the evidence. The probe is the falsifier (`species-contract.mjs`, variant `intrinsic-species-throws`): `p.constructor === Promise` → `true`, `routed=false`, `catch=Error: species getter exploded`, `exit=1` in default **and** strict; `Promise.resolve(p).then`, `Promise.race([p]).then` and `await p` do not contain it either (E44) |

## Conductor decisions

- **Q1 → S1 accepted** (2026-11-20, r2): the caller-visible status change is the cycle's one contract
  change — at the caller's resume `agent.status === "running"` for every prompt shape, and
  `identity.status` is deterministically `running`. Pinned by T6 (red on the baseline). **r4 keeps it** (E29).
- **Q3 → G1 accepted** (2026-11-20, r2): the ratchet is a closed list, and a legitimate addition to the
  window must edit the list — that edit is the decision prompt. **r3 kept the decision and fixed the
  mechanism** (G1′). **r4 keeps both and fixes the settle-body pin** (comment-masked, brace-matched; M15).
- **D8 residue → out of scope, filed as #542** (a pre-start failure leaves the agent record `running` while
  the run entry is `failed`; pre-existing, low). Not a unit in this cycle.
- **r4 finding #1 → entry marker accepted** (2026-11-20, round 3): a `debug`-level, state-free entry record
  is the tripwire; the `clearTimeout` count is demoted to a second, redundant signal (D1, D6.1).
- **r4 finding #2 → limit narrowed** (2026-11-20, round 3): the containment is behaviourally pinned for the
  finalize (M16) and retire (M17) steps; only the teardown catch is defence in depth (M18, measured green).
- **r5 findings #1–#5 → all accepted and patched** (2026-11-20, round 4): the regime checks are
  executable-body pins (M19/M21), the routing contract is narrowed to an ordinary native promise with the
  species residual named (E32, M20), catch-path logging is contained by `safeLog` (T4 case 6, T3 case 3),
  the lexer classifies regex literals and fails closed (T7), and the evidence is re-measured from a fresh
  tree with corrected counts and a runnable mutant script (Appendix A), and the shipped instrument is printed
  verbatim (Appendix B).
- **`safeLog`'s signature → a thunk, not a level argument** (2026-11-20, r5): forced by the existing
  structural guard (`terminal-status-consistency`), not by taste — measured, E38. Recorded so the next
  author does not "simplify" it back.
- **`logging.ts` global fix → #543, out of scope** (2026-11-20, r5): the console mirror is called outside
  the file-write catch. This unit contains its own catch-path calls only (D5.1).
- **r6 findings #1–#5 → all accepted and patched** (2026-11-20, round 5): one CONTRACT C450-R6 covering
  `constructor` **and** `Symbol.species` and separating *unsupported* from *necessarily rejected* (E44);
  **G1′ kept with the bare flow declaration** in the sketch and the PR checklist (E43); the self-contained
  mutant gate in Appendix A (E46); the measured `safeLog` reachability matrix replacing "sites 1–3" (E45);
  and E40's provenance corrected (E48).
- **G1′ is kept although the cheaper pin would fit the budget** (2026-11-20, r6): the round-5 critique's
  indentation-normalised window snapshot/hash would likely bring the test delta under the allowance (Q3
  has the line counts), and it was rejected on quality — opaque failure, comment-pinning, spelling-pinning.
  The delta is therefore **declared** (over by 353), not dodged. If the conductor prefers the hash, that is
  a Q3 reversal to take before implementation, not a review comment.

## Open questions for the conductor

1. **The marker's level.** `debug` is filtered out by default, so in production the record never exists and
   in tests the tripwire depends on `setLogLevel("debug")`. The alternative — `info` — would write one line
   per settle into every user's log. **Recommendation: `debug`** (E25 measures 0 bytes at the default), and
   the positive control is what keeps the test honest. Confirm, or direct `info` and accept the log noise.
2. **The un-mutated catches.** Measured in r6 (E45, D5.1): **sites 1, 3 and 5** are construction-only (0
   file-marker hits) and **site 4 is reached** by two existing tests but never with a throwing sink. Keep
   the unreachable ones (defence in depth) or drop them to shrink the delta? **Recommendation: keep them**,
   with the limit stated per site — a reviewer who wants one gone must show the step cannot throw.
3. **The four remaining `(err as Error).message` sites** (`stopAgent`, `steerAgent`, the deadline timer body
   ×2). Same fault class, outside this window. In scope for this cycle (four tokens + tests) or a follow-up?
   r5/r6 leave them and name them in §Risks.
4. **The species residual: accept-as-contract, or make it loud?** A native promise whose `constructor` **or**
   `Symbol.species` read throws exits the host (E32/E44), and nothing this unit can do contains it. The
   options are (a) accept it and keep CONTRACT C450-R6 + the probes (recommended: `async` cannot produce
   such a promise), or (b) add the R4 guard (`try { void runPromise.constructor } catch`) so the log says
   "out of contract" instead of a `TypeError` — 3 lines, no containment (Q2 row R4). Note (b) does not even
   cover the species read; it would need `runPromise.constructor[Symbol.species]` too, and still contains
   nothing. Decision needed only if the conductor wants the louder log.
5. **Site 4's containment is reachable and unpinned** (E45: both catch-all tests hit the line; neither makes
   the sink throw there). Accept the by-construction statement, or spend one variant test (`setConsoleOutput`
   + a throwing `console.error` in `review C: a throwing settle…`) — **~30 test lines**, taking the delta to
   939 against 556 (over by 383, declared anyway)? **Recommendation: accept the statement now** — the
   pre-start (T4 case 6) and routing (T3 case 3) paths already pin `safeLog`'s contract, and the gap is a
   property of the existing tests, not of this change.
6. **The declaration itself** (r5 critique #2). The PR must carry
   `Test budget: over-allowance — …` outside fences/blockquotes (E43), and Q3 now records that the cheaper
   hash pin would likely fit the allowance. Confirm **G1′ + declaration**, or direct the hash pin (a Q3
   reversal, ~−400 test lines, opaque failures). This is the one question that changes what the implementer
   types, so it should be answered before implementation rather than at review.

## What this investigation did **not** verify

- **The r6 measurements are this patch's own, and the r5 ones are not re-used as evidence.** Everything in
  E43–E49 was executed by this r6 dispatch on trees it built from the repository
  (`/tmp/brl450-r6/{intended,base}`, `/tmp/brl450-r6-mut`) after the r5 run had been killed and resumed.
  The r5 `/tmp` trees were **inspected**, and one of them was defective (E46: `m18.py` wrote to itself), so
  no r5 mutant result is quoted as r6 evidence. **Carried, not re-executed in r6:** E1, E2, E7, E15, E16,
  E18, E19, E22, E24, E25, E27, E28, E30, E33–E37, E39–E42 — their subjects are unchanged by r6 (r6 adds a
  comment to `session-manager.ts` and changes no test), and where a carried row feeds a claim that changed
  (E40, E42) the correction is recorded in its own row.
- **The full suite was not run in the repository.** It ran on two `/tmp` trees of the **same** corpus (both
  without `.git`), which is what makes the set comparison meaningful (E47); the absolute counts there
  (69 failed / 31 suites) therefore differ from the repository's (59 / 23, E36) **equally in both trees**.
  The implementer must run the real gate (`npx vitest run`, `tsc --noEmit`, `check:imports`, `docs:arch`)
  on the branch.
- **The r6 contract comment has not been through a real PR.** It is a comment: measured `tsc` 0, 179/179 in
  the two files, and a full-suite set identical to the baseline (E47). Nothing else about it is verified —
  in particular, no test can assert that a comment says what the contract says, which is why the contract is
  printed three times in this spec for review rather than pinned by an instrument.
- **The species residual is measured standalone, never through the spawn.** A session returning such a
  promise cannot be exercised in-process without either swallowing the rejection (defeating the probe) or
  exiting the runner, so E44's subprocess probe is the evidence, and there is **no** containment to pin in a
  test (C3). The `await` path's `attached=yes` with `exit=1` is measured at the process level; this spec
  does **not** explain the internal mechanism.
- **E40's three-level escape probe was not re-run in r6.** Only its `safeLog` half was (E48). The
  structural claim it rests on was re-read from the source: `src/logging.ts:157–159` calls the console
  mirror before the `try {` at `:166`, so a throwing `console.*` escapes `log.*` — which T4 case 6 and T3
  case 3 already demonstrate behaviourally on this tree (E35, carried).
- **Site 4's containment is reached but unpinned** (E45). A throwing sink at that line is not exercised by
  any test today; the reachability is measured, the containment behaviour is not.
- **`failPreStart`'s teardown containment has no behavioural mutant** — M18 (the teardown `try/catch`
  deleted) passes T4, now with a patch that really deletes it (E46). The finalize (M16) and retire (M17)
  steps **are** pinned. `clearInflightRun`'s own `catch` is unreachable through the harness (the function
  swallows its own errors, `run-registry.ts:261`), so M17 kills a deleted *step*, not a deleted `catch`.
- **"Regime 2's catch is unreachable for the SUPPORTED value" is argued, not tested.** It follows from
  `p.then === Promise.prototype.then` (E22), the species read succeeding for an ordinary promise (E44), and
  the spec: `PerformPromiseThen` with two function arguments cannot throw past that. No test asserts the
  catch is dead.
- **The regex/division heuristic is not a parser**, and it was **not fuzzed beyond T7's 14 rows**. A future
  author adding an exotic construct gets a red pin with a "fail closed" message — the designed outcome, but
  not a proof of coverage over all of JavaScript.
- **The pipeline identity capture was not measured end-to-end** (carried from r2). D4's pipeline
  consequence rests on E1 (spawn-level, same statement shape), a source read
  (`background-pipeline.ts:549–568`: the identity object literal is the first statement after the spawn
  `await`, no `await` in between) and T6's ratchet assertion.
- **`armDeadline`'s timer body was read, not re-probed**: the #453 behaviour it carries
  (`if (agent.completedAt) return`) is pinned by the existing tests at `:982` / `:1007` and by T3's timeout
  classification.
- **The spawn log statistics** (591/591, 0 timeouts) are quoted from the issue, not re-derived here.
- **The r6 test file was not linted** (`npx biome`/eslint equivalent) — only `tsc --noEmit` (exit 0), the
  two vitest runs, the full-suite JSON and the mutant gate. Formatting/import-order gates are the
  implementer's steps 15–16.
- **The per-test line figures in the §Delta rationale are approximate** (line ranges between `it(` calls in
  the r6 file, not a per-hunk attribution), and they are the basis for the Q3 note that the cheaper hash pin
  would likely fit the allowance. That note is an estimate; the critique's "does not by itself bring the
  delta under 514" is **not** reproducible from the r6 line counts, and it is flagged rather than smoothed
  over.
- **One r5 artifact was defective and is corrected, not carried**: `/tmp/brl450-r5-mutscripts/m18.py`
  rewrote itself instead of the source, so r5's "M18 GREEN" measured an unmutated tree (E46). The
  documented limit survives the correction — but the r5 evidence for it did not exist.

## Appendix A — the mutant gate (self-contained; findings #3 and #5)

**What it is.** One file, copied from here. It needs `bash`, `rsync`, `python3`, and a `node_modules` that
resolves `vitest` and `tsc` (the script refuses with **exit 2** if it does not). `BASE` is **your**
implemented tree; `WORK` is scratch (`/tmp/brl450-r6-mut` by default) and is rebuilt from `BASE/src` for
every case. It reads nothing else: the 21 patches are inline single-occurrence search/replace pairs (each
asserts its anchor's count is exactly 1, so a drifted source fails loudly with `PATCH FAILED`), and the
verdict is **derived**:

| `tsc --noEmit` | named selection | verdict printed |
|---|---|---|
| 0 | exit 1 | `RED` |
| 0 | exit 0 | `GREEN` |
| ≠ 0 | — | `COMPILE-FAIL` |

**Passing criterion: every row `RED` except M18, which must be `GREEN`** (the documented limit: the
teardown catch is unreachable through the harness). There is no `$want` column — the label and the exit
codes cannot disagree.

**This exact text was executed twice** (E46): on the r6 tree, and again **as extracted from this file** on
a **fresh** tree built from the repository with a fresh `WORK` — both times 21/21 patches applied, `tsc=0`
on every case, **20 RED, M18 GREEN**. That is the finding-#3 falsifier ("a fresh tree with none of the
proposer's `/tmp` state can execute it"), run rather than asserted. The r5 appendix's two failures are fixed here: it referenced 21 external
`python3` files that a reader did not have, and its stored M18 patch wrote its output to **its own file**,
so M18 never mutated the source (E46).

```bash
#!/usr/bin/env bash
# Issue #450 r6 — SELF-CONTAINED mutant gate.
#   BASE = a tree containing the r6 intended source (src/session-manager.ts and
#          src/__tests__/session-manager.test.ts) + a working node_modules.
# Every mutant is an exact single-occurrence search/replace inline below: no
# external patch files, no proposer /tmp state. The verdict is DERIVED:
#   tsc --noEmit exit 0 AND the named selection exit 1  => RED
#   tsc --noEmit exit 0 AND the named selection exit 0  => GREEN
#   tsc --noEmit exit non-zero                          => COMPILE-FAIL
# Passing criterion: every row RED except M18 (the documented limit, GREEN).
set -u
: "${BASE:?set BASE to the r6 tree}"
WORK=${WORK:-/tmp/brl450-r6-mut}
SRC=src/session-manager.ts
TESTFILE=src/__tests__/session-manager.test.ts
mkdir -p "$WORK"
rsync -a --exclude node_modules --exclude .git "$BASE/" "$WORK/"
# The toolchain must resolve INSIDE the work tree (exit 127 means it did not).
test -e "$WORK/node_modules/.bin/vitest" || { rm -rf "$WORK/node_modules"; ln -s "$BASE/node_modules" "$WORK/node_modules"; }
test -x "$WORK/node_modules/.bin/vitest" && test -x "$WORK/node_modules/.bin/tsc" || { echo "toolchain does not resolve under $WORK"; exit 2; }

m1 () { python3 - <<'PY'
p='src/session-manager.ts'; s=open(p).read()
old="""  const onSettleFault = (reason: unknown): void => {
    markSettleEntry('fault');
    if (deadlineHandle) clearTimeout(deadlineHandle);"""
assert s.count(old)==1
open(p,'w').write(s.replace(old,"""  const onSettleFault = (reason: unknown): void => {
    markSettleEntry('fault');""",1))
PY
}

m2 () { python3 - <<'PY'
p='src/session-manager.ts'; s=open(p).read()
old="""    runPromise = session.prompt(wrapTask(params.task));
  } catch (err) {"""
assert s.count(old)==1
s=s.replace(old,"""    runPromise = session.prompt(wrapTask(params.task));
    void Promise.prototype.then.call(runPromise, resolveSettled, rejectSettled);
  } catch (err) {""",1)
start=s.index("  try {\n    void Promise.prototype.then.call(runPromise, resolveSettled, rejectSettled);")
end=s.index("\n  }\n\n  return agent;", start)+4
s=s[:start]+s[end:]
open(p,'w').write(s)
PY
}

m3 () { python3 - <<'PY'
p='src/session-manager.ts'; s=open(p).read()
attach="  settled.then(onSettled).catch(onSettleFault);\n"
assert s.count(attach)==1
s=s.replace(attach,"",1)
anchor="\n  return agent;\n"
i=s.index(anchor, s.index("// ---- REGIME 2"))
open(p,'w').write(s[:i]+"\n"+attach+s[i:])
PY
}

m4 () { python3 - <<'PY'
p='src/session-manager.ts'; s=open(p).read()
old="  let runPromise: Promise<unknown>;\n"
assert s.count(old)==1
open(p,'w').write(s.replace(old,"  if (Date.now() > 0) throw new Error('hidden fault');\n"+old,1))
PY
}

m5 () { python3 - <<'PY'
p='src/session-manager.ts'; s=open(p).read()
old="\n  // ---- REGIME 1"
assert s.count(old)==1
open(p,'w').write(s.replace(old,"\n  if (Date.now() > 0) throw new Error('hidden fault');\n"+old,1))
PY
}

m6 () { python3 - <<'PY'
p='src/session-manager.ts'; s=open(p).read()
old="    runPromise = session.prompt(wrapTask(params.task));"
assert s.count(old)==1
open(p,'w').write(s.replace(old,"    if (Date.now() > 0) throw new Error('hidden fault');\n"+old,1))
PY
}

m7 () { python3 - <<'PY'
p='src/session-manager.ts'; s=open(p).read()
old="    void Promise.prototype.then.call(runPromise, resolveSettled, rejectSettled);"
assert s.count(old)==1
open(p,'w').write(s.replace(old,"    if (Date.now() > 0) throw new Error('hidden fault');\n"+old,1))
PY
}

m8 () { python3 - <<'PY'
p='src/session-manager.ts'; s=open(p).read()
old="    failPreStart(sanitizeErrorMessage(reason, effectiveCwd));"
assert s.count(old)==1
open(p,'w').write(s.replace(old,old+"\n    rejectSettled(err);",1))
PY
}

m9 () { python3 - <<'PY'
p='src/session-manager.ts'; s=open(p).read()
old="""    const reason = thrownMessage(err);
    failPreStart(sanitizeErrorMessage(reason, effectiveCwd));"""
assert s.count(old)==1
open(p,'w').write(s.replace(old,"""    failPreStart(sanitizeErrorMessage((err as Error).message, effectiveCwd));""",1))
PY
}

m10 () { python3 - <<'PY'
p='src/session-manager.ts'; s=open(p).read()
old="      const err = normalizeThrown(reason);"
assert s.count(old)==1
open(p,'w').write(s.replace(old,"      const err = reason as Error;",1))
PY
}

m11 () { python3 - <<'PY'
p='src/session-manager.ts'; s=open(p).read()
anchor="  settled.then(onSettled).catch(onSettleFault);\n"
assert s.count(anchor)==1
open(p,'w').write(s.replace(anchor, anchor+'    if (Date.now() > 0) throw new Error("hidden fault");\n',1))
PY
}

m12 () { python3 - <<'PY'
p='src/session-manager.ts'; s=open(p).read()
old="    failPreStart(sanitizeErrorMessage(reason, effectiveCwd));"
assert s.count(old)==1
s=s.replace(old,old+"\n    rejectSettled(err);",1)
old2="""  const onSettleFault = (reason: unknown): void => {
    markSettleEntry('fault');
    if (deadlineHandle) clearTimeout(deadlineHandle);
    try {"""
assert s.count(old2)==1
open(p,'w').write(s.replace(old2,old2+"""
      throw new Error("fault body entered, then died before its writes");""",1))
PY
}

m13 () { python3 - <<'PY'
p='src/session-manager.ts'; s=open(p).read()
old="    void Promise.prototype.then.call(runPromise, resolveSettled, rejectSettled);"
assert s.count(old)==1
open(p,'w').write(s.replace(old,"    runPromise.then(resolveSettled, rejectSettled);",1))
PY
}

m14 () { python3 - <<'PY'
p='src/session-manager.ts'; s=open(p).read()
old="""    failPreStart(sanitizeErrorMessage(reason, effectiveCwd));
    throw err;"""
assert s.count(old)==1
s=s.replace(old,"""    failPreStart(sanitizeErrorMessage(reason, effectiveCwd));
    deadlineHandle = undefined;
    rejectSettled(err);
    throw err;""",1)
old2="""  const onSettleFault = (reason: unknown): void => {
    markSettleEntry('fault');
    if (deadlineHandle) clearTimeout(deadlineHandle);
    try {"""
assert s.count(old2)==1
open(p,'w').write(s.replace(old2,old2+"""
      throw new Error("entered and failed");""",1))
PY
}

m15 () { python3 - <<'PY'
p='src/session-manager.ts'; s=open(p).read()
old="""  const onSettleFault = (reason: unknown): void => {
    markSettleEntry('fault');
    if (deadlineHandle) clearTimeout(deadlineHandle);
    try {"""
assert s.count(old)==1
decoy = """  const onSettleFault = (reason: unknown): void => {
    /* decoy for an unanchored text pin:
  const onSettleFault = (reason: unknown): void => {
    markSettleEntry('fault');
    if (deadlineHandle) clearTimeout(deadlineHandle);
    */
    if (false && deadlineHandle) clearTimeout(deadlineHandle);
    try {
      throw new Error("body entered then dies");"""
open(p,'w').write(s.replace(old,decoy,1))
PY
}

m16 () { python3 - <<'PY'
p='src/session-manager.ts'; s=open(p).read()
old="""    try {
      finalizeRunEntry('failed', message);
    } catch (err) {
      safeLog(() =>
        log.warn(`spawnBackgroundSession: pre-start finalize failed for ${id}`, {
          error: thrownMessage(err),
        }),
      );
    }"""
assert s.count(old)==1
open(p,'w').write(s.replace(old,"    finalizeRunEntry('failed', message);",1))
PY
}

m17 () { python3 - <<'PY'
p='src/session-manager.ts'; s=open(p).read()
old="""    try {
      clearInflightRun(id);
    } catch (err) {
      safeLog(() =>
        log.warn(`spawnBackgroundSession: pre-start registry retire failed for ${id}`, {
          error: thrownMessage(err),
        }),
      );
    }"""
assert s.count(old)==1
open(p,'w').write(s.replace(old,"",1))
PY
}

m18 () { python3 - <<'PY'
# r6 CORRECTION: the r5 stored patch wrote its output to m18.py itself, so the
# source was never mutated and "M18 GREEN" measured the unchanged tree.
p='src/session-manager.ts'; s=open(p).read()
old="""    try {
      cleanupWorkBranch();
    } catch (err) {
      safeLog(() =>
        log.error(
          `spawnBackgroundSession: work-branch teardown failed for ${id} — the original spawn failure is preserved`,
          { error: thrownMessage(err) },
        ),
      );
    }"""
assert s.count(old)==1
open(p,'w').write(s.replace(old,"    cleanupWorkBranch();",1))
PY
}

m19 () { python3 - <<'PY'
p='src/session-manager.ts'; s=open(p).read()
old="""  const markSettleEntry = (kind: 'success' | 'fault'): void => {
    try {"""
assert s.count(old)==1
s=s.replace(old,"""  const markSettleEntry = (kind: 'success' | 'fault'): void => {
    /*
try {
    void Promise.prototype.then.call(runPromise, resolveSettled, rejectSettled);
  } catch
    */
    try {""",1)
old2="""  try {
    void Promise.prototype.then.call(runPromise, resolveSettled, rejectSettled);"""
assert s.count(old2)==1
s=s.replace(old2,"""  try {
    if (Date.now() > 0) throw new Error("regime post-call fault");
    void Promise.prototype.then.call(runPromise, resolveSettled, rejectSettled);""",1)
open(p,'w').write(s)
PY
}

m20 () { python3 - <<'PY'
p='src/session-manager.ts'; s=open(p).read()
old="    void Promise.prototype.then.call(runPromise, resolveSettled, rejectSettled);"
assert s.count(old)==1
open(p,'w').write(s.replace(old,"    void Promise.resolve(runPromise).then(resolveSettled, rejectSettled);",1))
PY
}

m21 () { python3 - <<'PY'
p='src/session-manager.ts'; s=open(p).read()
old="""  const markSettleEntry = (kind: 'success' | 'fault'): void => {
    try {"""
assert s.count(old)==1
s=s.replace(old,"""  const markSettleEntry = (kind: 'success' | 'fault'): void => {
    void `try {
    void Promise.prototype.then.call(runPromise, resolveSettled, rejectSettled);
  } catch`;
    try {""",1)
old2="""  try {
    void Promise.prototype.then.call(runPromise, resolveSettled, rejectSettled);"""
assert s.count(old2)==1
s=s.replace(old2,"""  try {
    if (Date.now() > 0) throw new Error("regime post-call fault");
    void Promise.prototype.then.call(runPromise, resolveSettled, rejectSettled);""",1)
open(p,'w').write(s)
PY
}

run_case () { # $1 name, $2 vitest -t selection, $3 patch function
  rsync -a --delete "$BASE/src/" "$WORK/src/"
  if ! ( cd "$WORK" && "$3" ) >/tmp/brl450-r6-patch.log 2>&1; then
    printf '%-34s | PATCH FAILED: %s\n' "$1" "$(tail -1 /tmp/brl450-r6-patch.log)"
    return
  fi
  local tsc sel_out verdict first
  tsc=$( cd "$WORK" && ./node_modules/.bin/tsc --noEmit >/dev/null 2>&1; echo $? )
  sel_out=$( cd "$WORK" && ./node_modules/.bin/vitest run "$TESTFILE" -t "$2" 2>&1; echo "vitest_exit=$?" )
  local vexit=${sel_out##*vitest_exit=}
  if [ "$tsc" -ne 0 ]; then verdict=COMPILE-FAIL
  elif [ "$vexit" -eq 1 ]; then verdict=RED
  elif [ "$vexit" -eq 0 ]; then verdict=GREEN
  else verdict="ERROR($vexit)"; fi
  mkdir -p "$WORK/logs"
  printf '%s\n' "$sel_out" > "$WORK/logs/$1.log"
  first=$(printf '%s\n' "$sel_out" | grep -E "AssertionError|Error: |expected |Tests " | sed -E "s/^ +//" | grep -v "Failed Tests" | head -1)
  printf '%-34s | tsc=%s | vitest=%s | %-12s | %s\n' "$1" "$tsc" "$vexit" "$verdict" "$first"
}

run_case M1-deadline-not-cleared          "async-rejection pin"           m1
run_case M2-merged-regimes                "non-thenable"                  m2
run_case M3-attach-below-call             "ratchet"                       m3
run_case M4-throw-before-deferred         "ratchet"                       m4
run_case M5-throw-after-attach            "ratchet"                      m5
run_case M6-throw-inside-regime1          "ratchet"                       m6
run_case M7-throw-inside-regime2          "ratchet"                       m7
run_case M8-settle-deferred-pre-start     "sentinel tripwire"             m8
run_case M9-old-nonError-path             "non-Error value"               m9
run_case M10-unnormalised-reject          "non-Error value"              m10
run_case M11-four-space-top-level-throw   "ratchet"                      m11
run_case M12-body-dies-before-writes      "sentinel tripwire"            m12
run_case M13-own-then-routing             "non-thenable"                 m13
run_case M14-conditional-handle-entry     "sentinel tripwire"            m14
run_case M15-comment-decoy-body-head      "ratchet"                      m15
run_case M16-finalize-containment-removed "rethrows the original throw"  m16
run_case M17-retire-step-deleted          "rethrows the original throw"  m17
run_case M18-teardown-catch-deleted       "rethrows the original throw"  m18
run_case M19-comment-decoy-regime-throw   "ratchet"                      m19
run_case M20-route-via-Promise.resolve    "non-thenable"                 m20
run_case M21-template-decoy-regime-throw  "ratchet"                      m21
```

### A.1 — reading the output

- `M<n>-… | tsc=0 | vitest=<0|1> | RED|GREEN | <first assertion or Tests line>` — one line per mutant; the
  last field is the test's own message, which is what §Mutants quotes.
- `PATCH FAILED: …` — the anchor matched 0 or 2+ times. Your implementation's text differs from this spec's
  at that point; reconcile the source with the spec (the patch is the specification of the edit being
  reverted), do not adjust the patch.
- `tsc=127`, `vitest_exit=127` — the toolchain did not resolve inside `WORK`. The script now checks that
  up front and exits 2 rather than printing 21 bogus `COMPILE-FAIL` rows (that happened on the first r6 run
  and is recorded in the §Probe hygiene note).
- A `GREEN` on any row other than **M18** is a **missing assertion**, not a redundant test: add the pin,
  or delete the mutant's claim from §Mutants. (M18 is the one row whose green is the finding.)

### A.2 — the two contract probes (rows C2 and C3; E44)

C2 and C3 are **not** source mutants: they hand the routing a value the intrinsic cannot attach, and the
evidence is the process exit. Run each variant under **both** policies; the expected signature is stated in
the file's header and in E44/E32.

```js
// Issue #450 r6: does the "safe constructor" wording cover Symbol.species?
// One variant per run. Expected signature (stated before running):
//   intrinsic-species-throws: routed=false, catch=Error: species getter exploded, exit=1 (both modes)
//   ordinary / subclass / cross-realm: routed=true, exit=0
//   non-thenable / custom-thenable: routed=false, catch=TypeError, exit=0 (no rejection exists)
//   proxy: routed=false, catch=TypeError, exit=1 (underlying rejection unowned)
import vm from "node:vm";
const variant = process.argv[2];

function report(label, p) {
  let routed = false, caught = null;
  try { void Promise.prototype.then.call(p, () => {}, () => {}); routed = true; }
  catch (e) { caught = `${e && e.name}: ${e && e.message}`; }
  console.log(`${variant} :: ${label} :: routed=${routed} :: catch=${caught ?? "-"}`);
}
function alive() { setTimeout(() => console.log(`${variant} :: ALIVE (exit 0)`), 60); }

if (variant === "intrinsic-species-throws") {
  const p = (async () => { throw new Error("later rejection"); })();
  console.log(`${variant} :: p.constructor === Promise -> ${p.constructor === Promise}`);
  const saved = Object.getOwnPropertyDescriptor(Promise, Symbol.species);
  Object.defineProperty(Promise, Symbol.species, { configurable: true, get() { throw new Error("species getter exploded"); } });
  report("intrinsic-promise-throwing-species", p);
  Object.defineProperty(Promise, Symbol.species, saved);
  alive();
} else if (variant === "ordinary") {
  report("ordinary", (async () => { throw new Error("later rejection"); })());
  alive();
} else if (variant === "subclass") {
  class Sub extends Promise {}
  report("subclass", Sub.reject(new Error("later rejection")));
  alive();
} else if (variant === "cross-realm") {
  const Other = vm.runInNewContext("Promise");
  report("cross-realm", new Other((_, rej) => rej(new Error("later rejection"))));
  alive();
} else if (variant === "non-thenable") {
  report("non-thenable {} ", {});
  alive();
} else if (variant === "custom-thenable") {
  report("custom-thenable", { then(res, rej) { rej(new Error("later rejection")); } });
  alive();
} else if (variant === "proxy") {
  const inner = (async () => { throw new Error("later rejection"); })();
  report("proxy-of-promise", new Proxy(inner, {}));
  alive();
} else { console.log("unknown variant"); }
```

`species-attach-paths.mjs` proves the "no containment exists" sentence by running four attach paths against
the same throwing `Symbol.species`:

```js
// Which attach paths survive a throwing `Symbol.species` on the intrinsic `Promise`?
// Expected (stated first): every path ends in the same species read, so each prints
// `attached=no` (or `attached=yes` yet leaves p's rejection unowned) and the process
// exits 1 under the default policy.
const path = process.argv[2];
const p = (async () => { throw new Error("later rejection"); })();
const saved = Object.getOwnPropertyDescriptor(Promise, Symbol.species);
Object.defineProperty(Promise, Symbol.species, { configurable: true, get() { throw new Error("species getter exploded"); } });
let attached = "no", caught = "-";
try {
  if (path === "intrinsic") void Promise.prototype.then.call(p, () => {}, () => {});
  else if (path === "resolve") void Promise.resolve(p).then(() => {}, () => {});
  else if (path === "race") void Promise.race([p]).then(() => {}, () => {});
  else if (path === "await") { (async () => { await p; })(); }
  attached = "yes";
} catch (e) { caught = `${e.name}: ${e.message}`; }
Object.defineProperty(Promise, Symbol.species, saved);
console.log(`${path} :: attached=${attached} :: caught=${caught}`);
setTimeout(() => console.log(`${path} :: ALIVE`), 60);
```

### A.3 — the `safeLog` totality probe (E40/E48)

It slices the **shipped** `safeLog` text out of a source file and calls it with seven hostile thunks; the
path is an argument, so point it at your tree (the r5 run hard-coded `/tmp/brl450-r5fresh`, which is exactly
the provenance defect E48 corrects).

```js
// Prove `safeLog`'s shipped text cannot throw — evaluate the EXACT slice from the
// source, not a copy.
import { readFileSync } from "node:fs";
const src = readFileSync("/tmp/brl450-r6/intended/src/session-manager.ts", "utf8");
const start = src.indexOf("function safeLog(write: () => void): void {");
const end = src.indexOf("\n}\n", start) + 3;
const text = src.slice(start, end);
console.log("--- shipped text ---\n" + text + "---");

const js = text.replace("(write: () => void): void {", "(write) {");
const safeLog = new Function(`${js}\nreturn safeLog;`)();

const unprintable = { [Symbol.toPrimitive]() { throw new Error("no"); } };
const hostileProxy = new Proxy({}, { getPrototypeOf() { throw new Error("trap"); } });
const attempts = {
  "Error thunk": () => { throw new Error("sink exploded"); },
  "null throw": () => { throw null; },
  "undefined throw": () => { throw undefined; },
  "unprintable object throw": () => { throw unprintable; },
  "proxy that throws on every trap": () => { throw hostileProxy; },
  "thunk that throws a throwing object literal": () => { throw new Proxy({}, { get() { throw new Error("g"); } }); },
};
let failures = 0;
for (const [name, fn] of Object.entries(attempts)) {
  try { const r = safeLog(fn); console.log(`ok  ${name} -> returned ${String(r)}`); }
  catch (e) { failures++; console.log(`FAIL ${name} -> safeLog threw ${e && e.message}`); }
}
try { const r = safeLog(() => {}); console.log(`ok  healthy thunk -> returned ${String(r)}`); }
catch { failures++; console.log("FAIL healthy thunk"); }
console.log(failures === 0 ? "SAFELOG_TOTAL=yes" : `SAFELOG_TOTAL=no (${failures})`);
```

## Appendix B — the shipped instrument, verbatim (findings #1 and #4)

Everything below was compiled, run and measured on the **r6** tree (E46/E47): `tsc` 0; 179/179 in the two
files; T1 green on the green tree and red on M6/M7/M15/M19/M21; T7 green (14/14 rows). The test file is
**byte-identical to r5's** (the r6 delta is 0 test lines), so this text is unchanged from r5 and was
re-verified by the r6 gate rather than re-derived. Copy it; do not re-invent the masker.


### B.1 — the lexer and the three body readers (module scope, above the `describe`)

```ts
const REGEX_PRECEDING_CHARS = "([{,;:=!&|?+-*%<>~^";

/** Words after which a `/` starts a regex literal (`return /re/.test(x)`). */
const REGEX_PRECEDING_WORDS = new Set([
	"return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
	"throw", "case", "do", "else", "yield", "await",
]);

/** The last character emitted as CODE before `i` (masked text: trivia is blank). */
function previousCodeChar(masked: string[], i: number): string {
	for (let j = i - 1; j >= 0; j--) {
		const c = masked[j];
		if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") return c;
	}
	return "";
}

/** The identifier ending immediately before `i` (for the keyword rule). */
function identifierBefore(source: string, i: number): string {
	let j = i;
	while (j > 0 && /[A-Za-z0-9_$]/.test(source[j - 1])) j--;
	return source.slice(j, i);
}

function maskCommentsAndStrings(source: string): string {
	const out = source.split("");
	const blank = (from: number, to: number): void => {
		for (let j = from; j < to; j++) if (out[j] !== "\n") out[j] = " ";
	};
	let i = 0;
	while (i < source.length) {
		const ch = source[i];
		if (ch === "/" && source[i + 1] === "*") {
			const end = source.indexOf("*/", i + 2);
			const stop = end < 0 ? source.length : end + 2;
			blank(i, stop);
			i = stop;
			continue;
		}
		if (ch === "/" && source[i + 1] === "/") {
			const nl = source.indexOf("\n", i);
			const stop = nl < 0 ? source.length : nl;
			blank(i, stop);
			i = stop;
			continue;
		}
		if (ch === "/") {
			const prev = previousCodeChar(out, i);
			const isRegex =
				prev === "" ||
				REGEX_PRECEDING_CHARS.includes(prev) ||
				REGEX_PRECEDING_WORDS.has(identifierBefore(source, i));
			if (!isRegex) {
				i++; // a division operator — real code, left alone
				continue;
			}
			let j = i + 1;
			let inClass = false;
			let closed = false;
			while (j < source.length) {
				const c = source[j];
				if (c === "\\") { j += 2; continue; }
				if (c === "\n") break;
				if (inClass) {
					if (c === "]") inClass = false;
				} else if (c === "[") {
					inClass = true;
				} else if (c === "/") {
					closed = true;
					break;
				}
				j++;
			}
			if (!closed) {
				throw new Error(
					`mask: cannot classify the "/" at offset ${i} — a regex literal must close on its line (fail closed: the pin must not pass on text it cannot read)`,
				);
			}
			blank(i + 1, j);
			i = j + 1;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") {
			let j = i + 1;
			while (j < source.length) {
				if (source[j] === "\\") { j += 2; continue; }
				if (source[j] === ch) { j++; break; }
				j++;
			}
			blank(i + 1, j - 1);
			i = j;
			continue;
		}
		i++;
	}
	return out.join("");
}

/**
 * The EXECUTABLE lines of the block whose `{` sits at `open`, in order (trimmed).
 *
 * The closer is found by BRACE MATCHING in masked text. The result is then
 * verified against a construct boundary: the closer must be followed on its own
 * line by nothing, `;`, `,`, `:`, `)`, or a `catch`/`finally`/`else` keyword.
 * Anything else means the match landed somewhere the masker could not read
 * (critique r4 #4: a `}` inside a regex truncated the body silently) — so this
 * throws and the pin FAILS rather than passing on a truncated body.
 */
function blockBodyLines(
	source: string,
	masked: string,
	open: number,
	label: string,
): { lines: string[]; close: number } {
	let depth = 0;
	let close = -1;
	for (let i = open; i < masked.length; i++) {
		if (masked[i] === "{") depth++;
		else if (masked[i] === "}") {
			depth--;
			if (depth === 0) { close = i; break; }
		}
	}
	expect(close, `no matching "}" for ${label}`).toBeGreaterThan(open);
	const lineEnd = source.indexOf("\n", close);
	const rest = source.slice(close + 1, lineEnd < 0 ? source.length : lineEnd).trim();
	expect(
		rest,
		`the closer found for ${label} is followed by "${rest}" on its own line — the masker cannot verify this block (fail closed)`,
	).toMatch(/^(?:[;,:)]|(?:catch|finally|else)\b|$)/);
	const bodyLines = source.slice(open + 1, close).split("\n");
	const bodyMasked = masked.slice(open + 1, close).split("\n");
	const lines = bodyLines
		.filter((_, idx) => bodyMasked[idx].trim() !== "")
		.map((l) => l.trim());
	return { lines, close };
}

/**
 * The EXECUTABLE lines of a declared arrow's body, in order (trimmed).
 *
 * The declaration is located in the MASKED source (so a comment can never be
 * mistaken for it), then the body is BRACE-MATCHED from its `{` to the matching
 * `}` — not by an unanchored regex or an `indexOf` on a pattern. Blank and
 * comment-only lines are dropped, so `[0]` is the body's first executable
 * statement.
 */
function handlerBodyLines(source: string, decl: string): string[] {
	const masked = maskCommentsAndStrings(source);
	const at = masked.indexOf(decl);
	expect(at, `declaration not found outside comments: ${decl}`).toBeGreaterThanOrEqual(0);
	const open = masked.indexOf("{", at + decl.length - 1);
	expect(open).toBeGreaterThan(at);
	return blockBodyLines(source, masked, open, decl).lines;
}

/**
 * The EXECUTABLE lines of the `try` block that CONTAINS `stmt` and OPENS on it.
 *
 * Issue #450 (critique r4 #1): the regime bodies were pinned by a regex over the
 * RAW window text, so a comment that spelled
 * `try {\n    void Promise.prototype.then.call(...)` anywhere in the window
 * satisfied the pin while the real regime body threw before the routing. This
 * locates the statement in MASKED text and requires the try body to open on it,
 * so a smuggled statement before the call/routing fails here, at the site.
 */
function regimeBodyLines(source: string, stmt: string): string[] {
	const masked = maskCommentsAndStrings(source);
	const at = masked.indexOf(stmt);
	expect(at, `regime statement not found outside comments: ${stmt}`).toBeGreaterThanOrEqual(0);
	const tryAt = masked.lastIndexOf("try {", at);
	expect(tryAt, `no "try {" before the regime statement: ${stmt}`).toBeGreaterThanOrEqual(0);
	const open = masked.indexOf("{", tryAt);
	const smuggled = masked.slice(open + 1, at).trim();
	// The message quotes the ORIGINAL slice: the masked one reads as blanks.
	expect(smuggled, `the regime body must OPEN on its declared statement — found "${source
		.slice(open + 1, at)
		.trim()}" before it`).toBe("");
	const block = blockBodyLines(source, masked, open, `the try block before ${stmt}`);
	expect(
		masked.slice(block.close + 1).trimStart().startsWith("catch"),
		"the matched block must be a try/catch",
	).toBe(true);
	return block.lines;
}
```

### B.2 — T1's body pins (the tail of the ratchet test, after the WINDOW walk)

```ts
		// Regime 1's body is EXACTLY the call: a statement before it runs while
		// the session state is still "never issued".
		expect(
			regimeBodyLines(windowSrc, "runPromise = session.prompt(wrapTask(params.task));"),
			"regime 1's body must be EXACTLY the prompt call",
		).toEqual(["runPromise = session.prompt(wrapTask(params.task));"]);
		// Regime 2's body is EXACTLY the routing: a statement before it is a
		// fault between the call and the deferred's settlement.
		expect(
			regimeBodyLines(
				windowSrc,
				"void Promise.prototype.then.call(runPromise, resolveSettled, rejectSettled);",
			),
			"regime 2's body must be EXACTLY the routing",
		).toEqual([
			"void Promise.prototype.then.call(runPromise, resolveSettled, rejectSettled);",
		]);
		// Both settle bodies are pinned on their EXECUTABLE first statement, inside
		// the brace-matched body — NOT on text that merely appears in the window
		// (critique r3 #1: a block-comment decoy satisfied the old regexes).
		// `handlerBodyLines` masks comments and strings before locating the
		// declaration, so the pin can only land on real code.
		const settledBody = handlerBodyLines(windowSrc, "const onSettled = (): void => {");
		const faultBody = handlerBodyLines(windowSrc, "const onSettleFault = (reason: unknown): void => {");

		// (a) The body-ENTRY marker is FIRST — before the deadline clear, before
		// any transcript/event work. T5 asserts ZERO entry records on the
		// sync-throw path, which is only meaningful because the marker does not
		// depend on `deadlineHandle` still being set (r3's body-entry tripwire did:
		// the critic unset the handle and still entered the body, T5 green).
		expect(settledBody[0], "the success body must open on its entry marker").toBe(
			"markSettleEntry('success');",
		);
		expect(faultBody[0], "the fault body must open on its entry marker").toBe(
			"markSettleEntry('fault');",
		);
		// (b) D7 stays pinned immediately behind it: the deadline clear is still the
		// body's next statement, which keeps T5's `clearTimeout` count a SECOND,
		// independent entry signal.
		expect(settledBody[1], "the success body's deadline clear must follow the marker").toBe(
			"if (deadlineHandle) clearTimeout(deadlineHandle);",
		);
		expect(faultBody[1], "the fault body's deadline clear must follow the marker").toBe(
			"if (deadlineHandle) clearTimeout(deadlineHandle);",
		);
		// Ordering as the property itself (attach before call), so a revert to
		// the old shape fails on the sentence it violates.
		expect(windowSrc.indexOf("settled.then(onSettled)")).toBeLessThan(
			windowSrc.indexOf("session.prompt("),
		);
```

### B.3 — T7 (the instrument's own table; 11 rows must read the true body, 3 must refuse)

```ts
	it("reads regex literals and FAILS CLOSED on what it cannot classify (#450 T1 instrument)", () => {
		// Critique r4 #4: the lexer the pin uses was weaker than the ratchet
		// section admitted — a regex BEFORE a declaration could hide it, and a `}`
		// inside a regex silently TRUNCATED the returned body. The table below is
		// the instrument's own test: every case either reads the TRUE body or the
		// pin REFUSES. A case that returned a short body would fail the `toEqual`.
		const decl = "const onSettled = (): void => {";
		const head = `${decl}\n`;
		const clear = "\t\tif (deadlineHandle) clearTimeout(deadlineHandle);\n";
		const close = "\t};\n";

		const readsTrueBody: Array<[string, string, string[]]> = [
			[
				"a `/[/*]/` before the declaration (used to swallow the file)",
				`const before = /[/*]/;\n${head}${clear}${close}`,
				["if (deadlineHandle) clearTimeout(deadlineHandle);"],
			],
			[
				"a `/[//]/` before the declaration (the `//` is inside a class)",
				`const before = /[//]/;\n${head}${clear}${close}`,
				["if (deadlineHandle) clearTimeout(deadlineHandle);"],
			],
			[
				"a `/[}]/` inside the body (used to truncate it at the `}`)",
				`${head}${clear}\t\tconst r = /[}]/;\n\t\tafter();\n${close}`,
				[
					"if (deadlineHandle) clearTimeout(deadlineHandle);",
					"const r = /[}]/;",
					"after();",
				],
			],
			[
				"a `/[/*]/` inside the body",
				`${head}${clear}\t\tconst r = /[/*]/;\n\t\tafter();\n${close}`,
				[
					"if (deadlineHandle) clearTimeout(deadlineHandle);",
					"const r = /[/*]/;",
					"after();",
				],
			],
			[
				"an escaped slash `/a\\/b/` inside the body",
				`${head}${clear}\t\tconst r = /a\\/b/;\n\t\tafter();\n${close}`,
				[
					"if (deadlineHandle) clearTimeout(deadlineHandle);",
					"const r = /a\\/b/;",
					"after();",
				],
			],
			[
				"a template literal with `${...}` braces inside the body",
				`${head}${clear}\t\tconst s = \`a\${ { x: "}" } }b\`;\n\t\tafter();\n${close}`,
				[
					"if (deadlineHandle) clearTimeout(deadlineHandle);",
					'const s = `a${ { x: "}" } }b`;',
					"after();",
				],
			],
			[
				"a block comment spelling the marker inside the body",
				`${head}${clear}\t\t/* decoy: markSettleEntry('success'); */\n\t\tafter();\n${close}`,
				["if (deadlineHandle) clearTimeout(deadlineHandle);", "after();"],
			],
			[
				"a line comment containing `}`",
				`${head}${clear}\t\t// } is not a closer\n\t\tafter();\n${close}`,
				["if (deadlineHandle) clearTimeout(deadlineHandle);", "after();"],
			],
			[
				"nested braces on one line",
				`${head}${clear}\t\tconst o = { a: { b: 1 } };\n\t\tafter();\n${close}`,
				[
					"if (deadlineHandle) clearTimeout(deadlineHandle);",
					"const o = { a: { b: 1 } };",
					"after();",
				],
			],
			[
				"a string containing `/*` and `}`",
				`${head}${clear}\t\tconst s = "/* } */";\n\t\tafter();\n${close}`,
				[
					"if (deadlineHandle) clearTimeout(deadlineHandle);",
					'const s = "/* } */";',
					"after();",
				],
			],
			[
				"a division (not a regex literal)",
				`${head}${clear}\t\tconst h = total / 2;\n\t\tafter();\n${close}`,
				[
					"if (deadlineHandle) clearTimeout(deadlineHandle);",
					"const h = total / 2;",
					"after();",
				],
			],
		];
		for (const [name, source, expected] of readsTrueBody) {
			expect(handlerBodyLines(source, decl), name).toEqual(expected);
		}

		const refuses: Array<[string, string, RegExp]> = [
			[
				"a regex the heuristic cannot classify (after `)`) — the `}` must not truncate",
				`${head}${clear}\t\tif (ok) /[}]/.test(s);\n\t\tafter();\n${close}`,
				/fail closed/,
			],
			[
				"an unterminated regex",
				`${head}${clear}\t\tconst r = /abc\n${close}`,
				/must close on its line/,
			],
			[
				"a declaration that exists only inside a comment",
				`/*\n${head}${clear}${close}*/\n`,
				/declaration not found outside comments/,
			],
		];
		for (const [name, source, pattern] of refuses) {
			expect(() => handlerBodyLines(source, decl), name).toThrow(pattern);
		}
	});
```

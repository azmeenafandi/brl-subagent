# Implementation spec (**r2**) — #543: the console mirror can throw out of any logger call

**Base:** `dev @ ba5e9f1` (`git diff ba5e9f1..HEAD -- src/` empty, re-checked at `0e50cbc`) · **Priority:** low · **C-level:** C2
**Revision:** r2 answers `project-plan-critic` round 1 (`needs-work`, 3 major / 3 minor —
`issue-543-plan-critique-r1-2026-11-20.md`) and executes the conductor's D1–D6. Supersedes r1 (`3ccf9bd`).
**Decision:** unchanged — wrap the console mirror **in place**, one `try` around *selection **and** call* (option A).
Measured r2 shape: **+8 source / +127 test**, allowance **136** → **within by 9** (§11).

Contract (D4 — **this sentence is the catch comment in §4, word for word**):
> The mirror fault does not prevent the file-write attempt when a cwd is configured; persistence remains conditional on
> the file sink, and `log.*` returns normally.

## r2 changes (r1 → r2)

| # | r1 gap (critic) | r2 resolution | Where | Evidence (measured this round) |
|---|---|---|---|---|
| **G1** | retry-after-fault promised, untested: a latch can disable the mirror forever while every case passes | **case 7** — one fault, then a healthy call **in the same module instance** must reach the console **and** the file; new mutant **M7** (`consoleOutput = false` in the catch) | §5.1, §6 | M7 + r1's 16 cases → **16 passed** (the gap, reproduced exactly); M7 + r2's 17 → **1F/16P**, the only red being case 7 |
| **G2** | the failing-set claim was never establishable: targeted tests only, then the fixed tree's full suite | three-tree capture **A clean base → B test-patched base → C fixed**, failing **names** recorded and `comm`-diffed; any only-in-C name falsifies AC8 | §7, §12 | A `69F/3045`; B `76F/3052`; C `69F/3052` → **7 only-in-B**, **0 only-in-C** |
| **G3** | `git diff --numstat` is not the flow gate (working tree, not the committed head) | the real gate `node scripts/check-test-budget.mjs --flow --base dev --head <final sha>` **at the committed head**, exit + output recorded; numstat demoted to an estimate | §11, §12 | `test-flow: +127/+8 src (allowance 136) — within`, **exit 0**; base-as-head → `already-merged`, **exit 2** |
| **G4** | “the entry is still written” was unconditional | contract reworded to the file-**attempt** claim, conditional on a configured cwd; persistence stays with the file sink | contract, §3.1, §4 | probe: no cwd + throwing mirror → returns, **mirror attempted once, no file created**; base → throws |
| **G5** | delta understated (net-zero doc counted +1; blank lines dropped) | recomputed on the integrated tree: source **+8** (`logging.ts` 10/2, doc 6/6 net 0), test **+127**, allowance **136**, **within by 9** | §11 | real `--flow` run, not a numstat estimate |
| **G6** | “five cases” / “all 5 new red cases” omitted the disabled-mirror guard | **six → seven, five → six** — see the note below; the guard is named as green-on-base everywhere | §5.1, §6, §7 | M1 **6F/11P**; step B full suite **7** only-in-B names |

**G6 arithmetic, measured and said out loud.** r1 shipped 6 added cases: 5 exception cases red on base + the
disabled-mirror guard green on base. D1's retry case is its own `it()` **and is red on base** (on base the first call
throws out of `log.warn`), so r2 has **7 added cases, 6 baseline-red, 1 green-on-base guard** and step B's full suite
shows **7** only-in-B names, not “five”. D1's own wording (“fails that test while passing the **other 16**”) already
implies 17. D6's “six added / five baseline-red” is r1's count, superseded by D1; if the conductor insists on exactly
six, the retry assertions must be folded into case 1 — then M7 is killed by an existing case rather than by “that
test”. **Recommendation: adopt the measured 7/6** (open question 1).

## 1. Context and the measured defect

`createLogger`'s mirror (`src/logging.ts:157–160`) runs **outside** any `try`; only the file write is wrapped
(`:166–175`). `JSON.stringify(entry)` at `:153` is also unguarded — a separate hole, now **#545**, out of scope.

With `setConsoleOutput(true)` / `BRL_LOG_CONSOLE` and a hostile console, **both** halves of the observable fail today —
`log.*` throws **and** the entry is never written (the mirror precedes the write):

| scenario (real `logging.ts`, real fs, `/tmp` cwd) | `log.*` | file entry |
|---|---|---|
| `console.warn`/`.error`/`.log` throws | **throws `console blew up`** | **absent** |
| `console.warn === undefined` | **`TypeError: consoleMethod is not a function`** | **absent** |
| `console` Proxy whose `warn` **get** throws | **throws `get trap blew up`** | **absent** |
| mirror off, throwing console | returns | present |
| mirror on, healthy console | returns, **1** mirror call | present |
| mirror on, throwing console, **no cwd** | **throws** with no write attempt at all | n/a — no file sink |
| cyclic `data`, mirror **off** | **throws `TypeError` (circular)** | **absent** — #545, out of scope |

**Measured trigger (#450 T4):** in a containment catch the mirror throw *becomes* the caller's error and skips the rest
of the cleanup. `session-manager.test.ts:3669` (comment `:3755–3757`) said so in its own comment and now asserts the opposite.

## 2. Recon verification (checked against `ba5e9f1`)

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | One site, `src/logging.ts:155–160` | **Off by 2** — `if` 157, selection 158, call 159, close 160 | `nl -ba src/logging.ts \| sed -n '155,161p'` |
| 2 | Only the file write is wrapped | **Confirmed**, bounds `if (logDir)` 165, `try` **166–175** | same read; not “165–179”. `JSON.stringify` 153 is outside too |
| 3 | `consoleOutput` module state, opt-in, default off | **Confirmed** — init `:55`, setter `:110`, resolver `:84–87` accepts `1\|true\|yes` | `grep -n "consoleOutput\|BRL_LOG_CONSOLE" src/logging.ts` → 52,55,76,85,110,156,157 |
| 4 | `safeLog` doc names #543 as the global fix | **Confirmed** — doc **163–171**, `safeLog` **172**, `src/logging.ts:158` on **165** | `grep -n "function safeLog\|src/logging.ts:\|#543" src/session-manager.ts` |
| 5 | `logging.test.ts`: 10 cases, `resetModules` + env + spies + restore | **Confirmed** — `grep -c "^\s*it("` → **10**; spies `:36–38`, restore `:42–44`, `freshLogger(level, consoleEnv)` `:55` | as printed |
| 6 | No other raw `console.*` in `src/` | **Confirmed** — only console **call sites** are the mirror (`:158–159`); the other 2 hits are comments | `grep -rn "console\." src --include=*.ts \| grep -v __tests__` → **3 lines** (`logging.ts:158`, `transcript.ts:9`, `event-bus.ts:6`) |
| 7 | `JSON.stringify` throws on cyclic `data`, out of scope | **Confirmed, measured** — throws with the mirror **off**; filed as **#545** | §1 row 7 |
| 8 | “the file entry is still written” is the observable | **Confirmed — and it is the bigger half**: the entry is *lost* today | §1 rows 1–3, `fileEntry=null` |
| 9 | *(new)* the #450 case's own comment, and a naive assertion's vacuity | **Confirmed, re-measured** — case 5 writes the same message to the same file first | §5.2 (vacuity: `1 passed` on base without the isolation line) |

Recon correction standing for rows 1–3 and 6: mirror `157–160`, write `try` `166–175`, resolver `84–87`, `logging.ts:158`
is code — never a comment.

## 3. Options (all measured in the `/tmp` copy harness, §13)

| # | Option | Mechanism | Blast radius | Cost (r2) | Risk if wrong |
|---|---|---|---|---|---|
| **A** | **Wrap the mirror in place**, selection + call inside the try | 1 try, 1 catch, 5 comment lines | `logging.ts` only | +10/−2 → **+8** | a permanently broken mirror is silent (the entry still lands) |
| B | Lift the whole `log()` body into one `try/catch` | outer try over level check, `JSON.stringify`, mirror, write | all of `log()` | +9/−2 | **6F/11P** (17 cases): contains the throw but **still loses the entry** (mirror precedes write) and **swallows the cyclic-`JSON.stringify` throw** (scope leak) |
| C | Reorder: write the file before the mirror | move one block | write order, every call | 0 | **6F/11P**: entry survives, `log.*` still throws — primary observable unfixed |
| D | Extract `mirror(level, prefix, message)` with the guard inside | new module-local fn | +1 fn, new call edge | ~+12 | no benefit over A; one more name to keep honest |
| E | Do nothing | — | — | 0 | `safeLog`'s documented premise stays false; containment stays defeatable by the environment |

Outcomes (17 cases, `npx vitest run src/__tests__/logging.test.ts`): base **6F/11P**, **A 17P**, B **6F**, C **6F**.

**Recommendation: A** — the only shape satisfying *both* halves with the smallest diff, leaving `JSON.stringify` exactly
as loud as today. B fails the file-entry half for the reason the defect exists; C fixes only the visible half.

### 3.1 Sub-decisions

- **Absent / non-function console method:** *no `typeof` guard* — the wrap covers it (measured: `threw=null`, entry
  written). **Selection** is what is not free: `const consoleMethod = …` must stay *inside* the try (M2, **1F/16P**).
- **State after a fault:** **stateless.** Skipping later mirrors needs a new module flag (reset semantics, test surface)
  and silently disables a debugging aid after one transient fault. Once per call, every call — this is the contract
  **case 7** and **M7** now enforce.
- **Contract (D4):** the blockquote at the top of this file, verbatim in the catch comment. It claims only that the fault
  does not *prevent* the write attempt, and only when a cwd is configured; the file sink keeps its own `catch {}`.

## 4. The edit

`src/logging.ts`, replace **157–160** (`diff -u base vFinal` = **10 insertions, 2 deletions**):

```ts
		if (consoleOutput) {
			try {
				// Selection is inside the try on purpose — a replaced console can
				// throw on the property access itself, not only on the call.
				const consoleMethod = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
				consoleMethod(`[${prefix}] ${level.toUpperCase()}: ${message}`);
			} catch {
				// Issue #543: the mirror fault does not prevent the file-write attempt
				// when a cwd is configured; persistence remains conditional on the file
				// sink, and `log.*` returns normally.
			}
		}
```

Nothing else changes — `entry`/`line` (`145–153`), `resolveLogDir()` (`128–130`), `rotateIfNeeded`, the file `catch {}`
(`173–175`), `LOG_LEVELS`, `setLogCwd`, the `consoleOutput` default: AC10 is a `git diff` review of exactly this.

**Required truth fix — `src/session-manager.ts:163–171` (net 0: 6/−6).** The block is now false (“calls the console
mirror OUTSIDE its file-write catch”). Replacement:

```ts
/**
 * Issue #450 (D5): a log call on an ERROR path must never replace the error it
 * reports — a throwing sink becomes the caller's error and skips every later
 * step of the cleanup. `src/logging.ts` used to propagate a console-mirror
 * fault; #543 contains it at the sink (a mirror fault is swallowed like a
 * file-write fault). The entry build can still throw — `JSON.stringify` on
 * cyclic `data` sits outside the sink's catches (#545) — so this wrapper stays
 * as a belt-and-braces sensor, local to the settle/pre-start paths.
 */
```

`safeLog` is **not** retired here: the `JSON.stringify` path is still unguarded (#545), so the wrapper remains a real
local sensor. After the edit `grep -rn "logging.ts:158\|OUTSIDE its file-write" src/ scripts/` → **0 hits** (measured).

## 5. Tests

### 5.1 `src/__tests__/logging.test.ts` — 2 helpers, 1 signature change, **7 added cases** (10 → 17)

Same idiom: `vi.resetModules()` per import, env restored, spies in `beforeEach`, `mockRestore` in `afterEach`; add
`node:fs`/`node:os`/`node:path` imports, then before `restoreEnv`:

```ts
/** #543: per-test throwaway cwd so the file half of the contract is observable. */
const tempDirs: string[] = [];
function tempCwd(): string {
	const dir = mkdtempSync(join(tmpdir(), "brl-log543-"));
	tempDirs.push(dir);
	return dir;
}
function readLog(cwd: string): string {
	try {
		return readFileSync(join(cwd, ".pi", "subagent-logs", "brl-subagent.log"), "utf-8");
	} catch {
		return "";
	}
}
```

`afterEach` gains, **before** `vi.resetModules()`:
`for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });`

`freshLogger` gains a third parameter **and passes it through** — `createLogger` sets `logCwd` eagerly (`:137–139`), so
no `setLogCwd` call is needed:
`async function freshLogger(level, consoleEnv, cwd?) { … return { mod, log: mod.createLogger("test", cwd) }; }`

| # | case (line in the probed tree) | asserts | red on base? |
|---|---|---|---|
| 1–3 | `swallows a throwing console.warn/.error/.log and still appends the file entry (#543)` `:200`, `:213`, `:226` | `not.toThrow()`, **exactly 1** mirror call, file has `"level":"…"` **and** the message | **red** |
| 4 | `contains an absent console method (console.warn === undefined)` `:239` | `not.toThrow()`, entry present; `realWarn` captured **after** `mockRestore` | **red** |
| 5 | `contains a console whose property ACCESS throws — selection inside the guard` `:254` | `not.toThrow()` against a Proxy get-trap; entry present; console restored in `finally` | **red** |
| 6 | `leaves the disabled mirror unchanged under a throwing console` `:272` | mirror **never called**, entry present | **green** (a guard) |
| 7 | `keeps mirroring after a swallowed fault — same module instance` `:283` | see below | **red** |

```ts
	it("keeps mirroring after a swallowed fault — same module instance (#543)", async () => {
		const cwd = tempCwd();
		warnSpy.mockImplementationOnce(() => {
			throw new Error("console blew up");
		});
		const { log } = await freshLogger(undefined, "1", cwd);

		expect(() => log.warn("faulting call")).not.toThrow();
		log.warn("healthy after fault");

		// Once per call, every call: a transient fault must not disable the mirror
		// for the rest of the process (#543 review, G1).
		expect(warnSpy).toHaveBeenCalledTimes(2);
		expect(warnSpy).toHaveBeenLastCalledWith("[test] WARN: healthy after fault");
		expect(readLog(cwd)).toContain("faulting call");
		expect(readLog(cwd)).toContain("healthy after fault");
	});
```

Case 7 is D1: one fault, then a **second call in the same module instance** must reach the console (2 calls, the last
the healthy message) and the file (both entries). It is the only case that kills M7; it is red on base for the same
reason cases 1–3 are. `mockImplementationOnce` means the second call falls through to the spy's default no-op.

**Why the Proxy case is not gold-plating:** it is the only test that kills M2 (“guard the call, not the selection”).

### 5.2 `src/__tests__/session-manager.test.ts` — the measured trigger, end to end

In `"normalises a non-Error value on BOTH regimes and rethrows the original throw (#450)"` (`:3669`), case **(6)**
(comment `:3755–3757`), three edits:

1. **Isolate the sink first** (case 5 already wrote the same message to the same file):
   `rmSync(join(env.baseDir, ".pi", "subagent-logs", "brl-subagent.log"), { force: true });`
2. After `expect(clearSpy6).toHaveBeenCalled();` add `expect(readLog()).toContain("pre-start finalize failed");`
3. Replace the comment that promises the opposite with
   `// (#543) the entry still reaches the file — a mirror fault no longer aborts the write.`

`rmSync` and `readLog()` already exist in that file (`:2`, `:777`), so the delta is **4 added / 2 deleted**.

**Measured (all re-run this round):**

| run | result |
|---|---|
| base source + patched tests (`-t` filter) | **1 failed** — `AssertionError: expected '' to contain 'pre-start finalize failed'` (the file is not even created: the mirror throws before `mkdirSync`) |
| base source, **isolation line removed** | **1 passed** — the vacuity proof; the assertion must ship with the `rmSync` |
| fixed source + patched tests | **1 passed / 138 skipped** |

## 6. Mutants (each executed; `npx vitest run src/__tests__/logging.test.ts`, r2's 17 cases)

| # | Mutant | Killed by | Measured |
|---|---|---|---|
| M1 | no guard (`ba5e9f1`) | **all 6 red-on-base cases** (5 exception + the retry case) | **6F/11P** |
| M2 | selection hoisted **outside** the try | the Proxy get-trap case, and only it | **1F/16P** |
| M3 | whole `log()` body wrapped (option B) | the 6 `readLog` assertions (`not.toThrow` passes) | **6F/11P** |
| M4 | reorder write-before-mirror only (option C) | the 6 `not.toThrow` assertions | **6F/11P** |
| M5 | mirror made unconditional (`if (true)`) | 3 existing “off” cases + the new disabled-mirror case | **4F/13P** |
| M6 | `return;` inside the catch (skip the write) | the 6 file-entry assertions | **6F/11P** |
| **M7** | **latch the mirror off in the catch** (`consoleOutput = false;`) — the critic's G1 mutant | **case 7 only** | **1F/16P**; with r1's 16-case file the same mutant reads **16 passed** |

M7 is round-1's G1 made executable: r1's suite could not see it at all.

## 7. Baseline capture — the three-tree proof (D2)

A two-tree comparison cannot make the failing-set claim: **A** (clean base: old source **and** old tests) does not
contain the new cases at all, so “the fix closes exactly the new cases” is not expressible there. **B** (old source,
**new tests**) is the only tree where the new cases exist and are expected to fail; the fixed tree **C** is compared
against both.

| tree | source | tests | `logging.test.ts` | `-t "normalises a non-Error value"` | full suite |
|---|---|---|---|---|---|
| **A** clean base (`ba5e9f1`) | base | base | 10 passed | 1 passed | **3045 tests, 69 failed** (all `/tmp`-copy artifacts) |
| **B** test-patched base | base | new | **6 failed / 11 passed (17)** | **1 failed** — `expected '' to contain 'pre-start finalize failed'` | **3052 tests, 76 failed** |
| **C** fixed | fix | new | **17 passed** | 1 passed / 138 skipped | **3052 tests, 69 failed** |

Name-set diffs (sorted `fullName` of every failed assertion, `comm`):

- **B vs A:** **7 names only-in-B** — the 6 red logging cases **+** the extended `#450` case. Nothing else moved.
- **A vs C:** **0 only-in-A, 0 only-in-C** — the fixed tree's failure set is identical to the clean base's.
- **B vs C:** **7 only-in-B, 0 only-in-C** — the fix closes exactly the set B predicted and opens nothing. **AC8 holds.**

The 69 shared failures are copy artifacts, not regressions (`transport-auto-retry.test.ts` asserts `not.toContain("/tmp")`;
the `scripts/` suites need a real repo root/`.git`). They are **equal in A and C**, which is what makes the set
comparison valid; the in-repo clean-base run is still the implementer's job (§14) — there “69” must be **0**.

Reproduce: per tree `npx vitest run --reporter=json --outputFile=/tmp/p/<A|B|C>.json`, dump `testResults[]
.assertionResults[]` with `status === "failed"` as `fullName`, `sort -u`, then `comm`.

## 8. Acceptance criteria (numbered, testable)

1. Throwing `console.log`/`warn`/`error` with the mirror on: `log.info/warn/error` return normally (cases 1–3).
2. The same call still appends the file entry with the level and the message (cases 1–3), **when a cwd is configured**.
3. The mirror is attempted **exactly once** per passing call — never 0 when enabled, never >1 (cases 1–3, 6, 7).
4. Mirror disabled: no console method is called; the entry is still written (case 6).
5. A console whose property **access** throws is contained — selection inside the try (case 5, kills M2).
6. **Retry after a fault (D1):** with the mirror on, a throwing mirror followed by a healthy call **in the same module
   instance** reaches the console (2 attempts, the last the healthy message) and the file (both entries) — case 7, the
   only case that kills M7.
7. The #450 T4 integration case proves the original error is preserved **and** the line reaches the file, non-vacuously
   (isolation line present, §5.2).
8. All 10 pre-existing `logging.test.ts` cases unchanged; the full-suite failing set differs from **B** by exactly the
   **7** names of §7 and from **A** by **0** names. **Any only-in-C name falsifies this AC.**
9. `npx tsc --noEmit` exits 0 (measured on the fixed tree).
10. `git diff` touches only `src/logging.ts`, `src/__tests__/logging.test.ts`, `src/__tests__/session-manager.test.ts`
    and the `src/session-manager.ts` doc block; `git diff src/logging.ts` changes none of `entry`/`line`/`resolveLogDir`/
    `rotateIfNeeded`/the file `catch {}`/`LOG_LEVELS`/the `consoleOutput` default.
11. A cyclic `data` value **still throws** `TypeError: Converting circular structure to JSON` — this is what separates A
    from B. Diff-reviewed; optional as a test (O1, §15). Follow-up: **#545**.
12. **Flow gate (D3):** `node scripts/check-test-budget.mjs --flow --base dev --head <final sha>` run **at the committed
    head before merge** exits 0 with `+127/+8 src (allowance 136) — within`; the output line and exit code go into the PR.

## 9. Risks and failure modes

- **A masked mirror fault is invisible.** A permanently throwing console becomes silent. Accepted: the file sink is the
  source of truth and still records the entry. Sink health counters are a different issue.
- **An empty-looking `catch` invites deletion.** Mitigation: the D4 sentence in it, the Proxy case (M2) and the retry
  case (M7) — deleting the guard reddens 6 cases; latching instead of swallowing reddens 1.
- **Test hygiene.** Case 5 restores `globalThis.console` in `finally`; case 4 captures `realWarn` **after** `mockRestore`
  (before it, `console.warn` *is* the spy); temp dirs are removed before `resetModules` so a late write cannot resurrect one.
- **Vacuous integration assertion.** Without the `rmSync` line the case passes on base (measured) — isolation ships with it.
- **Budget headroom is 9 lines** (136 − 127). Anything beyond it needs a `Test budget:` line in the PR body.

## 10. Scope boundary

- **In:** mirror containment, its 7 tests, the #450 assertion + comment, the two stale comments.
- **Out:** log levels/verbosity, rotation, `MAX_LOG_SIZE`/`MAX_LOG_FILES`, entry shape, file location, `safeLog`'s
  removal, the `JSON.stringify(entry)` throw. `consoleOutput` stays opt-in and off by default — M5 shows making it
  unconditional reddens 4 tests.
- **#545** (cyclic/BigInt `data` throws out of `log.*` before the file catch) is filed and **out of scope**: real,
  measured, a different fix — and why `safeLog` survives this PR.

## 11. Delta and the real flow gate (D3, D5)

| file | + | − | net |
|---|---|---|---|
| `src/logging.ts` | 10 | 2 | **+8** |
| `src/session-manager.ts` (doc block) | 6 | 6 | **0** |
| **source net** | | | **+8** → allowance **120 + 2×8 = 136** |
| `src/__tests__/logging.test.ts` | 129 | 4 | +125 |
| `src/__tests__/session-manager.test.ts` | 4 | 2 | +2 |
| **test net** | | | **+127** → **within by 9** |

The `--numstat` rows are the **estimate**; the gate is the script, run at the repository root on the final committed head:

```
$ node scripts/check-test-budget.mjs --flow --base dev --head <final sha>
test-flow: +127/+8 src (allowance 136) — within (base …)
$ echo $?
0
$ node scripts/check-test-budget.mjs --flow --base dev --head <dev sha>   # the guard: a post-merge replay
test-flow: already-merged (base …) — … a post-merge replay must not silently pass.
$ echo $?
2
```

r1 claimed **+114 test / allowance 136 / within by 22** (the critic's G5 measurement). r2 is **+127 / 136 / within by
9**: the retry case and the spelled-out throw cases cost 13 lines. **Still within — no cut needed**; if review adds more
than 9 test lines, cut case 3 (`console.log`) first — cases 5–7 are the only killers of M2 and M7.

## 12. Execution sequence (D2, D3)

1. `git switch -c fix/543-console-mirror` from `ba5e9f1`.
2. **Step A — clean base:** `npx vitest run --reporter=json --outputFile=/tmp/p/A.json` on the untouched tree; record the
   failing **names** — in-repo **0 failed** (the copy's 69 are artifacts, §7).
3. Write §5.1's helpers + **7** cases and §5.2's three edits; do **not** touch `src/` yet.
4. **Step B — test-patched base:** `npx vitest run --reporter=json --outputFile=/tmp/p/B.json`; expect
   `logging.test.ts` **6 failed / 11 passed (17)** (the disabled-mirror guard passes), the `-t` filter **1 failed**, and
   the full suite = A's set **+ 7 names**. Record them.
5. Apply the §4 `logging.ts` guard; `npx vitest run src/__tests__/logging.test.ts` → **17 passed**.
6. Apply the §4 doc block; `grep -rn "logging.ts:158\|OUTSIDE its file-write" src/ scripts/` → **0 hits**.
7. **Step C — fixed tree:** `npx tsc --noEmit` (exit 0), `git diff --check`, then the full suite → record the names and
   `comm` them against A and B: **0 only-in-C** against both, **7 only-in-B**. Any only-in-C name falsifies AC8.
8. Commit, then **at that committed head** run the real gate from the repository root:
   `node scripts/check-test-budget.mjs --flow --base dev --head <final sha>` → paste the printed line and `$?`.
9. Any amend invalidates step 8's sha — **re-run it** at the new head before merge.
10. PR body `## Design assumptions`: no new state (existing log file, path, modes `0o700`/`0o600`); teardown
    unchanged; concurrency unchanged (synchronous append, per-call guard); file `catch {}` and the new mirror `catch {}`
    both fail-open; evidence = steps 2–8 commands and output.
11. Optional O1: pin that cyclic `data` still throws, making AC11 executable.

## 13. Evidence log

- `gh issue view 543` — both halves of the observable, fix direction (“wrap in its own try/catch **or** lift the whole
  body”), `Priority: low`, trigger on `dev @ 338a930`; `gh issue view 545` — the filed follow-up.
- `git diff ba5e9f1..HEAD -- src/` → empty at `0e50cbc` (base still valid).
- `nl -ba src/logging.ts` 40–180 — mirror **157–160**, write `try` **166–175**, `JSON.stringify` 153, `consoleOutput`
  55/110, resolver `84–87` (accepts `1|true|yes`), `resolveLogDir` `128–130` (returns `undefined` with no `logCwd`),
  `createLogger(prefix, cwd?)` `137–139`.
- `grep -rn "console\." src --include=*.ts | grep -v __tests__` → **3 lines** (`logging.ts:158` + 2 comments);
  `grep -c "^\s*it(" src/__tests__/logging.test.ts` → **10**; `session-manager.test.ts` — `it` **3669**, comment
  **3755–3757**, `readLog()` **777**, `rmSync` import **:2**.
- **Fixed tree (final shape, D4 wording):** `logging.test.ts` **17 passed**; `-t "normalises a non-Error value"` **1
  passed / 138 skipped**; `npx tsc --noEmit` → **exit 0** (printed `TSC_EXIT=0`); `git diff --check` clean.
- **Baseline-red (test-patched base):** `logging.test.ts` **6 failed / 11 passed (17)**, exactly the 6 predicted names;
  `-t` filter → `AssertionError: expected '' to contain 'pre-start finalize failed'`; isolation line removed → **1
  passed** (vacuity).
- **Mutants (17 cases):** M1 **6F/11P**, M2 **1F/16P**, M3 **6F/11P**, M4 **6F/11P**, M5 **4F/13P**, M6 **6F/11P**,
  M7 **1F/16P** (red name printed: `keeps mirroring after a swallowed fault`); M7 against r1's 16-case file → **16
  passed**.
- **Full suite (JSON reports, same copy):** A `3045 tests / 69 failed`, B `3052 / 76`, C `3052 / 69`; `comm` → B−A **7
  only-in-B**, A−C **0/0**, B−C **7 only-in-B, 0 only-in-C**.
- **Flow gate (real script, scratch git repo whose head carries the exact four-file diff):** `test-flow: +127/+8 src
  (allowance 136) — within (base ae62d23)`, **exit 0**; base-as-head → `already-merged`, **exit 2**. numstat rows
  `10/2`, `6/6`, `129/4`, `4/2`.
- **G4 probe (real logger, `mkdtemp` cwd, no `createLogger` cwd):** fixed → `threw=null calls=1 wroteAnyFile=false`;
  base → `threw=Error: console blew up calls=1 wroteAnyFile=false`.

## 14. Not verified

- **In-repo run.** Every number above was measured in `/tmp/probe543r2/repo` (rsync of the tree, `node_modules`
  symlinked; §7 explains why). The implementer must confirm the in-repo clean base is **0 failed** and re-run A/B/C.
- **The real `--flow` gate at the real head.** Run against a scratch repo carrying the same four-file diff; the
  merge-time run against `dev` and the PR sha is the gate, and its output must be pasted into the PR.
- **A genuinely broken stdout stream** (EPIPE/closed fd) rather than a replaced `console` object: not induced — same
  code path, but “host console throws” was simulated.
- **Rotation under a throwing console** (untouched; inside the file `try`), **`BRL_LOG_CONSOLE=1` in the #450 case**
  (it uses `setConsoleOutput(true)`; the env path is covered only in `logging.test.ts`), and the **real pi TUI**: not probed.

## 15. Open questions

1. **Confirm the G6 amendment** (7 added / 6 baseline-red / 7 step-B names): D1's retry case is itself red on base, so
   r1's 6/5 becomes 7/6. AC8's structure is unchanged; the PR description must use the r2 numbers or a reviewer will
   read a discrepancy. Alternative: fold the retry assertions into case 1 (then 6/5 holds, but M7 is killed by an
   existing case and D1's “the other 16” no longer describes the file). **Recommendation: adopt 7/6.**
2. **O1 (cyclic-data test):** pin the boundary as a test, or leave AC11 to diff review? It asserts a throw; it fits the
   9-line headroom barely. Recommendation: leave it to review here — #545 owns that behaviour.
3. **#545 sequencing:** the doc block cites #545. If #545 lands first, revisit the “belt-and-braces sensor” sentence;
   that edit belongs to #545's PR.

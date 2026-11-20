# Implementation spec — #543: the console mirror can throw out of any logger call

**Base:** `dev @ ba5e9f1` (`git diff ba5e9f1..HEAD -- src/` is empty — verified) · **Priority:** low · **C-level:** C2
**Decision:** wrap the console mirror **in place** — one `try` around *selection **and** call*. 8 net source lines
plus one stale doc block corrected. No reorder, no whole-body catch, no extraction.

Contract (verbatim in the code comment and §3.1):
> A console-mirror fault is swallowed like a file-write fault — the entry is still written to the file
> and `log.*` returns normally.

## 1. Context and the measured defect

`createLogger`'s mirror (`src/logging.ts:157–160`) runs **outside** any `try`; only the file write is
wrapped (`:166–175`). `JSON.stringify(entry)` at `:153` is also unguarded (separate hole, §10).

With `setConsoleOutput(true)` / `BRL_LOG_CONSOLE` and a hostile console, **both** halves of the observable
fail today — `log.*` throws **and** the entry is never written (the mirror precedes the write):

| scenario (real `logging.ts`, real fs, `/tmp` cwd) | `log.*` | file entry |
|---|---|---|
| `console.warn`/`.error`/`.log` throws | **throws `console blew up`** | **absent** |
| `console.warn === undefined` | **`TypeError: consoleMethod is not a function`** | **absent** |
| `console` Proxy whose `warn` **get** throws | **throws `get trap blew up`** | **absent** |
| mirror off, throwing console | returns | present |
| mirror on, healthy console | returns, **1** mirror call | present |
| cyclic `data`, mirror **off** | **throws `TypeError` (circular)** | **absent** — out of scope |

**Measured trigger (#450 T4):** in a containment catch the mirror throw *becomes* the caller's error and
skips the rest of the cleanup — the test at `src/__tests__/session-manager.test.ts:3755–3757` says so in
its own comment: "a throwing mirror runs before the file write and loses it". Reproduced in §5.2.

## 2. Recon verification (checked against `ba5e9f1`)

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | One site, `src/logging.ts:155–160` | **Off by 2** — `if` at 157, selection 158, call 159, close 160 | `nl -ba src/logging.ts \| sed -n '155,161p'`; the issue's own `158–160` (the two code lines) is right |
| 2 | Only the file write is wrapped | **Confirmed**, right bounds: `if (logDir)` 165, `try` **166–175** | same read; not "165–179". `JSON.stringify` 153 is outside too |
| 3 | `consoleOutput` module state, opt-in, default off | **Confirmed** — init `:55`, setter `:110`, resolver `:84–87` accepts `1\|true\|yes` | `grep -n "consoleOutput\|BRL_LOG_CONSOLE" src/logging.ts` → 52,55,76,85,110,156,157 |
| 4 | `safeLog` doc names #543 as the global fix | **Confirmed** — doc **163–171**, `safeLog` **172**, `src/logging.ts:158` ref on **165** | `grep -n "function safeLog\|src/logging.ts:\|#543" src/session-manager.ts` |
| 5 | `logging.test.ts`: 10 cases, `resetModules` + env + spies + restore | **Confirmed** — 10 `it(`; spies `:36–38`, restore `:42–44`, `freshLogger(level, consoleEnv)` `:55` | `grep -c "^\s*it(" ` → 10 |
| 6 | No other raw `console.*` in `src/` | **Confirmed** — only console **call sites** are the mirror (`:158–159`); other 2 hits are comments (`transcript.ts:9`, `event-bus.ts:6`) | `grep -rn "console\." src --include=*.ts \| grep -v __tests__` → 3 lines |
| 7 | `JSON.stringify` throws on cyclic `data`, out of scope | **Confirmed, measured** — throws with the mirror **off** | §1 row 6; §10 |
| 8 | "the file entry is still written" is the observable | **Confirmed — and it is the bigger half**: the entry is *lost* today | §1 rows 1–3, `fileEntry=null` |
| 9 | *(new)* the #450 case's own comment, and a naive assertion's vacuity | **New** — case (5) at `:3748` writes the same message to the same file first | §5.2, vacuity measured |

Recon corrections: mirror is `157–160` (not `155–160`); write `try` is `166–175`; env resolver `84–87`;
`logging.ts:158` is code, not a comment (claim 6's *conclusion* still holds).

## 3. Options (all measured in a `/tmp` copy harness, §6)

| # | Option | Mechanism | Blast radius | Cost | Risk if wrong |
|---|---|---|---|---|---|
| **A** | **Wrap the mirror in place**, selection + call inside the try | 1 try, 1 catch, 2 comment lines | `logging.ts` only | +10/−2 → **+8** | a permanently broken mirror is silent (entry still lands) |
| B | Lift the whole `log()` body into one `try/catch` | outer try over level check, `JSON.stringify`, mirror, write | all of `log()` | +9/−2 | **measured 5/16 red**: contains the throw but **still loses the entry** (mirror precedes write), and **swallows the cyclic-`JSON.stringify` throw** (scope leak) |
| C | Reorder: write the file before the mirror | move one block | write order, every call | 0 | **measured 5/16 red**: entry survives, `log.*` still throws — primary observable unfixed |
| D | Extract `mirror(level, prefix, message)` with the guard inside | new module-local fn | +1 fn, new call edge | ~+12 | no benefit over A; same 3-line guard, one more name to keep honest |
| E | Do nothing | — | — | 0 | `safeLog`'s documented premise stays false; containment remains defeatable by the environment |

Outcomes: base **5F/11P**, **A 16P**, B **5F**, C **5F** (`npx vitest run src/__tests__/logging.test.ts`, §6).

**Recommendation: A.** Only shape that satisfies *both* halves with the smallest diff, and it leaves
`JSON.stringify` exactly as loud as today. B fails the file-entry half for the very reason the defect
exists (mirror-then-write) — the trap in the issue's own "or lift the whole body" alternative. C fixes the
half that is easier to see and leaves the one that matters.

### 3.1 Sub-decisions

- **Absent / non-function console method:** *no `typeof` guard.* The wrap covers it (measured: `threw=null`,
  entry written). What is **not** free is the **selection**: `const consoleMethod = …` must stay *inside*
  the try — a Proxy whose `warn` get-trap throws is only contained that way (mutant M2, 1/16 red).
- **State after a fault:** **stateless.** Skipping later mirrors needs a new module flag (reset semantics,
  test surface) and would silently disable a debugging aid for the rest of the process after one transient
  fault. Once per call, every call, each attempt guarded.
- **Contract:** the blockquote above, verbatim in the catch comment.

## 4. The edit

`src/logging.ts`, replace **157–160** with (probed as `vFinal.ts`; `diff -u base vFinal` = 10 insertions, 2 deletions):

```ts
		if (consoleOutput) {
			try {
				// Selection is inside the try on purpose — a replaced console can
				// throw on the property access itself, not only on the call.
				const consoleMethod = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
				consoleMethod(`[${prefix}] ${level.toUpperCase()}: ${message}`);
			} catch {
				// Issue #543: a console-mirror fault is swallowed like a file-write
				// fault — the entry is still written to the file and `log.*` returns
				// normally.
			}
		}
```

Nothing else changes: `entry`/`line` (`145–153`), `resolveLogDir()` (`164`), `rotateIfNeeded`, the file
`catch {}` (`173–175`), `LOG_LEVELS`, `setLogCwd`, and the `consoleOutput` default (off) are untouched.

**Required truth fix — `src/session-manager.ts:163–171`.** The block becomes false ("calls the console
mirror OUTSIDE its file-write catch"). Replace with (Δ +9/−8):

```ts
/**
 * Issue #450 (D5): a log call on an ERROR path must never replace the error it
 * reports — a throwing sink becomes the caller's error and skips every later
 * step of the cleanup. `src/logging.ts` used to propagate a console-mirror
 * fault; #543 contains it at the sink (a mirror fault is swallowed like a
 * file-write fault). The entry build can still throw — `JSON.stringify` on
 * cyclic `data` sits outside the sink's catches — so this wrapper stays as a
 * belt-and-braces sensor, local to the settle/pre-start paths.
 */
```

`safeLog` is **not** retired here: the `JSON.stringify` path is still unguarded (measured), so the wrapper
remains a real local sensor.

## 5. Tests

### 5.1 `src/__tests__/logging.test.ts` — 2 helpers, 1 signature change, 5 cases

Same idiom: `vi.resetModules()` per import, env restored, spies in `beforeEach`, `mockRestore` in
`afterEach`. Add `node:fs`/`node:os`/`node:path` imports; add before `restoreEnv`:

```ts
/** #543: per-test throwaway cwd so the file half of the contract is observable. */
const tempDirs: string[] = [];
function tempCwd(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brl-log543-"));
	tempDirs.push(dir);
	return dir;
}
function readLog(cwd: string): string {
	try {
		return fs.readFileSync(path.join(cwd, ".pi", "subagent-logs", "brl-subagent.log"), "utf-8");
	} catch {
		return "";
	}
}
```

`afterEach` gains, **before** `vi.resetModules()`:
`for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });`

`freshLogger` gains a third parameter **and passes it through** — `createLogger` sets `logCwd` eagerly
(`src/logging.ts:137–139`), so no `setLogCwd` call is needed:

```ts
	async function freshLogger(level: string | undefined, consoleEnv: string | undefined, cwd?: string) {
		// …unchanged env restore + resetModules…
		// With no cwd, file output is skipped; a cwd opts the file sink in (#543).
		const mod = await import("../logging");
		return { mod, log: mod.createLogger("test", cwd) };
	}
```

The five cases: `warn`/`error`/`log` throws, absent method, Proxy access throw, disabled mirror.

```ts
	it("swallows a throwing console.warn and still appends the file entry (#543)", async () => {
		const cwd = tempCwd();
		warnSpy.mockImplementation(() => {
			throw new Error("console blew up");
		});
		const { log } = await freshLogger(undefined, "1", cwd);

		expect(() => log.warn("warn survives")).not.toThrow();
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(readLog(cwd)).toContain('"level":"warn"');
		expect(readLog(cwd)).toContain("warn survives");
	});
	// console.error / console.log: identical shape with errorSpy/logSpy and log.error/log.info.

	it("contains an absent console method (console.warn === undefined) (#543)", async () => {
		const cwd = tempCwd();
		const { log } = await freshLogger(undefined, "1", cwd);
		warnSpy.mockRestore();
		// Captured AFTER mockRestore: before it, `console.warn` IS the spy.
		const realWarn = console.warn;
		(console as { warn?: unknown }).warn = undefined;
		try {
			expect(() => log.warn("absent method survives")).not.toThrow();
		} finally {
			console.warn = realWarn;
		}
		expect(readLog(cwd)).toContain("absent method survives");
	});

	it("contains a console whose property ACCESS throws — selection inside the guard (#543)", async () => {
		const cwd = tempCwd();
		const { log } = await freshLogger(undefined, "1", cwd);
		const realConsole = globalThis.console;
		globalThis.console = new Proxy(realConsole, {
			get: (target, prop) => {
				if (prop === "warn") throw new Error("get trap blew up");
				return Reflect.get(target, prop);
			},
		});
		try {
			expect(() => log.warn("proxy survives")).not.toThrow();
		} finally {
			globalThis.console = realConsole;
		}
		expect(readLog(cwd)).toContain("proxy survives");
	});

	it("leaves the disabled mirror unchanged under a throwing console (#543)", async () => {
		const cwd = tempCwd();
		warnSpy.mockImplementation(() => {
			throw new Error("a disabled mirror must not call console at all");
		});
		const { log } = await freshLogger(undefined, undefined, cwd);
		expect(() => log.warn("disabled mirror")).not.toThrow();
		expect(warnSpy).not.toHaveBeenCalled();
		expect(readLog(cwd)).toContain("disabled mirror");
	});
```

**Why the Proxy case is not gold-plating:** it is the only test that kills M2 ("guard the call, not the
selection"). Without it that plausible implementation is fully green.

### 5.2 `src/__tests__/session-manager.test.ts` — the measured trigger, end to end

In `"normalises a non-Error value on BOTH regimes and rethrows the original throw (#450)"` (`:3669`),
case **(6)** (`:3755`), three edits:

1. **Isolate the sink first** (case 5 at `:3748` already wrote the same message to the same file):
   `rmSync(join(env.baseDir, ".pi", "subagent-logs", "brl-subagent.log"), { force: true });`
2. After `expect(clearSpy6).toHaveBeenCalled();` add `expect(readLog()).toContain("pre-start finalize failed");`
3. Replace the comment that promises the opposite with
   `// (#543) the entry still reaches the file — a mirror fault no longer aborts the write.`

**Measured:** with (1) removed the case **passes on `ba5e9f1`** (vacuity proof: `1 passed | 138 skipped`);
with (1) it is red on base — `AssertionError: expected '' to contain 'pre-start finalize failed'` (the file
is not even created; the mirror throws before `mkdirSync`) — and green on the fix.

## 6. Baseline-red proof (run it yourself)

```bash
npx vitest run src/__tests__/logging.test.ts
#   on ba5e9f1 -> 5 failed | 11 passed (16)
#     red:   throws-warn / throws-error / throws-log ("to not throw"), absent method, Proxy get-trap
#     green: the disabled-mirror guard (a guard, not a red) + all 10 pre-existing cases
npx vitest run src/__tests__/session-manager.test.ts -t "normalises a non-Error value on BOTH regimes"
#   -> 1 failed: expected '' to contain 'pre-start finalize failed'
# after §4:
npx vitest run src/__tests__/logging.test.ts                      # 16 passed
npx vitest run src/__tests__/session-manager.test.ts -t "normalises a non-Error value on BOTH regimes"  # 1 passed
npx tsc --noEmit                                                  # exit 0
```

Every number above was re-measured in an exact copy of the tree at `/tmp/probe543/repo` (rsync,
`node_modules` symlinked) — §14 explains why not in-repo.

## 7. Acceptance criteria (numbered, testable)

1. Throwing `console.log`/`warn`/`error` with the mirror on: `log.info/warn/error` return normally (3 cases).
2. The same call still appends the file entry, containing the level and the message.
3. The mirror is attempted **exactly once** per passing call — never 0 when enabled, never >1.
4. Mirror disabled: no console method is called; the entry is still written.
5. A console whose property **access** throws is contained (selection inside the try).
6. The #450 T4 integration case proves the original error is preserved **and** the line reaches the file,
   non-vacuously (isolation line present).
7. All 10 pre-existing `logging.test.ts` cases unchanged; the full-suite failing set differs from base by
   **exactly** the 6 new/extended cases, zero regressions (§13).
8. `npx tsc --noEmit` exits 0.
9. `git diff` touches only `src/logging.ts`, `src/__tests__/logging.test.ts`,
   `src/__tests__/session-manager.test.ts`, and the doc block in `src/session-manager.ts`.
10. `git diff src/logging.ts` shows no change to `entry`/`line`/`resolveLogDir`/`rotateIfNeeded`/the file
    `catch {}`/`LOG_LEVELS`/the `consoleOutput` default.
11. A cyclic `data` value **still throws** `TypeError: Converting circular structure to JSON` — the fix must
    not swallow it (this is what separates A from B). Diff-reviewed; optional as a test (O1, §15).

## 8. Mutants (each executed; `npx vitest run src/__tests__/logging.test.ts`)

| # | Mutant | Killed by | Measured |
|---|---|---|---|
| M1 | no guard (`ba5e9f1`) | all 5 new cases | **5F/11P** |
| M2 | selection hoisted **outside** the try | the Proxy get-trap case, and only it | **1F/15P** |
| M3 | whole `log()` body wrapped (option B) | the 5 `readLog` assertions (`not.toThrow` passes) | **5F/11P** |
| M4 | reorder write-before-mirror only (option C) | the 5 `not.toThrow` assertions | **5F/11P** |
| M5 | mirror made unconditional (`if (true)`) | 3 existing "off" cases + the new disabled-mirror case | **4F/12P** |
| M6 | `return;` inside the catch (skip the write) | the 5 file-entry assertions | **5F/11P** |

## 9. Risks and failure modes

- **A masked mirror fault is invisible.** A permanently throwing console becomes silent. Accepted: the file
  sink is the source of truth and still records the entry; the mirror is a convenience. Sink health
  counters are a different issue.
- **An empty-looking `catch` invites deletion.** Mitigation: the contract sentence in it, and the Proxy test
  (M2) — deleting the guard reddens 6 tests.
- **Test hygiene.** The Proxy case replaces `globalThis.console`; restore in `finally` or every later case
  sees the proxy. The absent-method case must capture `realWarn` **after** `mockRestore` (before it,
  `console.warn` is the spy); `afterEach`'s second `mockRestore` is idempotent (measured).
- **Temp dirs.** Removed in `afterEach` before `resetModules`, so no late write resurrects one.
- **Vacuous integration assertion.** Case (5) writes the same line first; without the `rmSync` isolation
  line, §5.2 passes on base (measured). The isolation is part of the test, not a nicety.

## 10. Scope boundary

- **In:** mirror containment, its tests, the two stale comments.
- **Out:** log levels/verbosity, rotation, `MAX_LOG_SIZE`/`MAX_LOG_FILES`, entry shape, file location,
  `safeLog`'s removal, the `JSON.stringify(entry)` throw. `consoleOutput` stays opt-in and off by default —
  M5 shows making it unconditional reddens 4 tests.
- **`JSON.stringify` is a real, separate hole** (measured: throws with the mirror *off*, entry lost). Not
  fixed here because swallowing it would hide a caller passing cyclic `data`. Deserves its own issue: same
  containment argument, different fix (stringify inside the file try, or a safe serializer). The issue text
  is silent on it; the exclusion is the dispatch's, recorded here so diff review can hold it.

## 11. Delta estimate (ADR 0028 flow rule: `120 + 2 × Δsource`)

| file | + | − | net |
|---|---|---|---|
| `src/logging.ts` | 10 | 2 | **+8** |
| `src/session-manager.ts` (doc block) | 9 | 8 | **+1** |
| **source net** | | | **+9** → allowance **138** |
| `src/__tests__/logging.test.ts` | 102 | 4 | +98 |
| `src/__tests__/session-manager.test.ts` | 6 | 2 | +4 |
| **test net** | | | **+102** → within by 36 |

Source numbers measured (`diff -u base vFinal`, real file); test numbers measured against the harness copy.
If §5.2 is deferred, the comment fix is still required and the test delta drops to +98.

## 12. Execution sketch

1. `git switch -c fix/543-console-mirror` from `ba5e9f1`.
2. Write §5.1 helpers + 5 cases first; run → record `5 failed | 11 passed` (baseline red, §6).
3. Apply §5.2's three edits; run the `-t` filter → record `expected '' to contain …`.
4. Apply the §4 `logging.ts` guard; both commands green (16/16, 1/1).
5. Apply the §4 doc block; `grep -rn "logging.ts:158" src/` → no hits.
6. `npx tsc --noEmit`; `git diff --check`.
7. Full suite `npx vitest run` — record the failing set and diff it against base's (AC 7).
8. Flow: `git diff --numstat --no-renames ba5e9f1` → source +9, test +102, allowance 138.
9. PR body `## Design assumptions`: no new state (existing log file, unchanged path; modes `0o700`/`0o600`);
   teardown unchanged; concurrency unchanged (synchronous append); missing/partial state unchanged (file
   `catch {}` and the new mirror `catch {}` both fail-open); evidence = §6 commands.
10. Optional O1: pin that cyclic `data` still throws, making AC 11 executable.

## 13. Evidence log

- `gh issue view 543` — title, both halves of the observable, fix direction ("wrap in its own try/catch **or**
  lift the whole body"), `Priority: low`, trigger measured on `dev @ 338a930`.
- `nl -ba src/logging.ts` 50–180 — mirror **157–160**, write `try` **166–175**, `JSON.stringify` 153,
  `consoleOutput` 55/110, resolver 84–87, `createLogger(prefix, cwd?)` 137–139, `resolveLogDir` 128–130.
- `grep -rn "console\." src --include=*.ts | grep -v __tests__` → **3 lines**: the mirror code
  (`logging.ts:158`) + 2 comments (`transcript.ts:9`, `event-bus.ts:6`).
- `grep -n "function safeLog\|src/logging.ts:\|#543" src/session-manager.ts` → doc `163–171`, `safeLog` **172**,
  ref on **165**.
- `grep -c "^\s*it(" src/__tests__/logging.test.ts` → **10**; `freshLogger` 2 params at `:55`.
- `session-manager.test.ts` — test at **3669**, case (5) assertion at **3748**, case (6) at **3755–3757**.
- **Re-verified this round:** vFinal **16 passed**; base **5F/11P** with exactly the 5 exception cases red;
  integration on base → `expected '' to contain 'pre-start finalize failed'` at `:3780`; vacuity proof —
  `rmSync` removed → `1 passed | 138 skipped` on base; M2 **1F/15P**, M5 **4F/12P**, M6 **5F/11P**; improved
  absent-method capture order → 16P, base still 5F/11P.
- Full suite in the copy: base `81 failed | 2969 passed | 1 skipped`; fix `75 failed | 2975 passed | 1 skipped`;
  `comm` of the FAIL-name sets → **6 only-in-base** (5 logging cases + the #450 case), **0 only-in-fix**.
  The 75 shared failures are `/tmp` copy artifacts (`transport-auto-retry.test.ts` asserts
  `not.toContain("/tmp")`; `scripts/` suites need a repo root/`.git`).
- Bank: `~/.cache/brl-subagent/bank/spec-543-r1.md`.

## 14. Not verified

- **In-repo run.** Everything ran in `/tmp/probe543/repo`. The implementer must confirm the in-repo full
  suite at the fix head, and that `ba5e9f1` is green in-repo.
- **A genuinely broken stdout stream** (EPIPE/closed fd) rather than a replaced `console` object: not
  induced. Same code path, but "host console throws" was simulated.
- **Rotation under a throwing console:** not probed; `rotateIfNeeded` is inside the file `try`, untouched.
- **`BRL_LOG_CONSOLE=1` in the integration test:** the #450 case uses `setConsoleOutput(true)`; the env path
  is covered only in `logging.test.ts`.
- **Real pi TUI:** not exercised.

## 15. Open questions

1. **Include §5.2 (the #450 integration assertion)?** It is the measured trigger and the only end-to-end
   proof; it costs 4 test lines + one `rmSync`. Deferring leaves `session-manager.test.ts:3757` claiming a
   behaviour the fix changes — the comment edit is required either way. Recommendation: include.
2. **File the `JSON.stringify` follow-up issue?** Real, measured, out of scope; recommend yes, referencing §10.
3. **O1 (cyclic-data test):** pin the boundary as a test, or leave AC 11 to diff review? It asserts a throw;
   only worth it if the conductor wants AC 11 executable.

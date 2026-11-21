# Implementation spec (**r1**) — #545: a cyclic/BigInt log `data` payload throws out of `log.*`

**Base:** `dev @ 22e1f77` · **Priority:** low · **C-level:** C2
**Decision:** serialise defensively — a cycle-collapsing + `BigInt`-encoding replacer, plus a whole-stringify `catch`
that emits a **marker entry** (option A). Measured three-file diff: **+48 net source** (`logging.ts` +49/−1,
`session-manager.ts` doc 5/5 net 0) / **+111 net test**, allowance **216** → **within by 105** (§9).

Contract (this sentence is the `serializeEntry` doc comment in §5.1, word for word):
> The replacer covers a cycle and a `BigInt`; the catch covers what it cannot — a throwing `toJSON`, getter or Proxy trap.

## 1. Context and the measured defect

`log()` serialises **before** every guard: filter `:142`, `entry` `:145–151`, `JSON.stringify(entry)` **`:153`**, mirror
`:157–168` (#543's `try`), file sink `:172–184`. A `data` that `JSON.stringify` refuses throws **out of `log.*`** — and
because serialisation precedes the mirror, it also suppresses the mirror and the write. Measured with the **real**
`src/logging.ts` (`~/.cache/brl-subagent/scratch/spec-545/probe-base.ts`, node 24 strip-types, `mkdtemp` cwd per case):

| `data` payload | `log.info` on **base** | file | mirror (on) |
|---|---|---|---|
| cyclic `{a:1, self:⤴}` | **throws** `TypeError: Converting circular structure to JSON…` | **absent** | **0 calls** |
| `{n: 10n}` | **throws** `TypeError: Do not know how to serialize a BigInt` | absent | 0 calls |
| throwing `toJSON()` | **throws** `Error: toJSON blew up` | absent | 0 calls |
| throwing getter | **throws** `Error: getter blew up` | absent | 0 calls |
| Proxy (`ownKeys`/`get` throw) | **throws** `Error: get trap blew up` | absent | 0 calls |
| healthy payload | returns | one line, exact shape | 1 call |
| healthy call **after** a fault, same module instance | returns, logs | one line | – (**no** sticky state on base) |

Since the #543 spec's row *“cyclic `data`, mirror off → throws”*: the mirror still runs **after** `JSON.stringify`, so a
cyclic payload now suppresses the mirror **too** (`mirrorCalls=0` with `setConsoleOutput(true)`). #543 landed at
`d95420e` and does not touch this hole.

**Fixed tree, same probe** (`probe-fixed.ts`): every row returns normally and the file gets its line — cyclic →
`{"a":1,"self":"[Circular]"}`; `10n` → `{"n":"10n"}`; `toJSON`/getter/Proxy → `"[unserializable data: <reason>]"`
(`toJSON blew up`, `getter blew up`, `get trap blew up`); cyclic + mirror ON → **1** mirror call; healthy payload →
**byte-identical** to base. Zero-regression on normal payloads measured separately (`probe-identical.ts`): **9 of 9**
realistic serialisable payloads (date, `undefined`/`null`, nested arrays, deep object, empty object, `toJSON` object,
shared reference) serialise **byte-identically** with the replacer.

## 2. Recon (Rule 13 — codegraph @ 22e1f77)

```
recon: index stale (indexed 717230312523 != HEAD 22e1f77ef292) — refreshing…
## Recon (Rule 13 — codegraph @ 22e1f77)
- target: `createLogger` (file: src/logging.ts)
- callers(createLogger):
  - 14 caller(s)
  - src/runner.ts:58 (fallbackLog)
  - src/scratch-spawn.ts:75 (fallbackLog)
  - src/transcript.ts:10 (log)
  - src/session-manager.ts:56 (log)
  - src/store-permissions.ts:27 (log)
  - src/event-bus.ts:7 (log)
  - src/runtime.ts:46 (createRuntime)
  - src/event-bus.ts:1 (event-bus.ts)
  - src/runner.ts:1 (runner.ts)
  - src/runtime.ts:1 (runtime.ts)
  - src/scratch-spawn.ts:1 (scratch-spawn.ts)
  - src/session-manager.ts:1 (session-manager.ts)
  - … +2 more
- impact(createLogger, depth 2):
  - 66 affected symbols across 55 files
  - files: src/logging.ts, src/runner.ts, src/scratch-spawn.ts, src/transcript.ts, src/session-manager.ts, src/store-permissions.ts, src/event-bus.ts, src/runtime.ts …
- affected(src/logging.ts):
  - 98 test file(s)
  - src/__tests__/boot-recovery-factory.test.ts
  - src/__tests__/kill-escalation.test.ts
  - src/__tests__/mode-runners-boundary.test.ts
  - src/__tests__/notify-completion.test.ts
  - src/__tests__/recovery-boot-notice.test.ts
  - src/__tests__/recovery-retry-after-boot.test.ts
  - src/__tests__/recovery-surface.test.ts
  - src/__tests__/recovery-visibility-bridge.test.ts
  - src/__tests__/recovery.test.ts
  - src/__tests__/run-registry.test.ts
  - …
- grep delta: 22 raw hits for `createLogger` (incl. comments/strings) — record what grep added or the graph missed
```

**Verification of the code facts** (all re-read on this tree, from the repo root):

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | `logging.ts` is 221 lines | **Confirmed** | `wc -l src/logging.ts` → `221` |
| 2 | Body order = filter → `entry` → stringify → mirror → logDir → `try{mkdir,rotate,append}catch{}` | **Confirmed**, bounds: filter **142**, `entry` **145–151**, stringify **153**, mirror **157–168**, `logDir` **172**, `try` **174–183** | `nl -ba src/logging.ts \| sed -n '137,195p'` |
| 3 | The unguarded stringify also suppresses the mirror | **Confirmed, measured** | §1 row 1: `mirrorCalls=0` with the mirror on |
| 4 | `logging.test.ts` 300 lines / 17 cases, `resetModules` + `tempCwd`/`readLog` + `freshLogger(level, consoleEnv, cwd?)` | **Confirmed** | `wc -l` → `300`; `grep -c "^\s*it("` → **17**; helpers **24–37**, cleanup **65**, `freshLogger` **76–85** |
| 5 | `safeLog` documents the “never crash” premise and names #545 | **Confirmed** — doc **163–171**, `function safeLog` **172**, `#545` on **169** | `grep -n "function safeLog\|#545" src/session-manager.ts` |
| 6 | 22 raw `createLogger` hits | **Confirmed, reconciled exactly**: 20 non-test + 2 test = **22** = 1 definition (`logging.ts:137`) + 7 imports + **7 call sites** + 5 comments (`logging.ts:9,113,171`, `runtime.ts:11`, `index.ts:239`) + 2 test mentions | `grep -rn "createLogger" src --include=*.ts \| grep -v __tests__` → **20**; `grep -rn "createLogger" src/__tests__` → **2** |
| 7 | Recon's “14 callers” | **Confirmed** = 7 call sites + 7 import edges (`transcript:5`, `scratch-spawn:51`, `session-manager:32`, `runtime:25`, `event-bus:3`, `store-permissions:25`, `runner:46`). Grep added **no** call site the graph missed; the 5 comments + the definition are why grep reads 20 | same greps, `cat -n` |
| 8 | The defect is `data`-shaped, not entry-shaped | **Confirmed** — the other four fields are `string`/`LogLevel` written by `log()` itself | §1: all five hostile shapes live inside `data` |

## 3. Options

Each built on the **base** source and measured against the **same 24-case** `logging.test.ts` (§6), in
`~/.cache/brl-subagent/scratch/spec-545/repo` (rsync copy, `node_modules` symlinked). Base **5F/19P**, fixed **24P**.

| # | Option | Mechanism | Blast radius | Cost | Risk if wrong | Verified |
|---|---|---|---|---|---|---|
| **A** | **Defensive serialisation** (recommended) | `serializeEntry(entry)` = `JSON.stringify(entry, circularSafeReplacer())` — cycle → `[Circular]`, `BigInt` → `\`${v}n\`` — in one `catch` that re-emits the entry with `data: "[unserializable data: <reason>]"` | `logging.ts`; every call, `data` only | +49/−1 source, +111 test | a cycle becomes a string; the pathological payload loses its body (the marker still says why) | **24P**; 9/9 normal payloads byte-identical |
| B | Drop the unserializable `data` | no replacer; `catch` re-emits `{…entry, data: "[unserializable]"}` | same | ~+12 | a **cycle** and a **BigInt** — the two shapes the issue names — each lose the whole payload, and the marker cannot say which | **4F/20P**: cases 1–4 red; only the retry case passes |
| C | Wrap the whole `log()` body in one `try/catch` | outer `try` over filter→entry→stringify→mirror→write | all of `log()` | +3/−1 | **loses the line entirely** (the throw precedes mirror and write) — the issue's own observable fails; mutes every future sink fault with no comment | **5F/19P** (same red set as base) |
| D | Reorder: serialise after the mirror | move `line` below `:168` | every call | ~0 | the mirror is fixed, the throw still escapes | **5F/19P** |
| E | Do nothing | — | — | 0 | `safeLog`'s premise stays false at 100 % of `log.*` sites; the settle/deadline catch-alls keep assuming totality | **5F/19P** (= M1) |

**Recommendation: A** — the only option where every reported shape returns normally **and** still records the line, and
the only one that keeps partial detail (`[Circular]`, `"10n"`) for the two shapes the issue names. B is cheaper and
strictly worse on exactly those two; C satisfies “does not throw” while losing the observable; D fixes the wrong layer.

**Falsifiers.** (1) If cycles/`BigInt` were unreachable from real call sites, E/B would be proportionate — not the case:
`data` is `Record<string, unknown>` at 7 call sites, and `err`/`agent`/`result` objects are passed directly. (2) If the
file were a **wire format**, rewriting `data` to a string would break a consumer — measured: no reader
(`grep -rn "subagent-logs" src scripts` → producers only; tests read it as text). (3) If case 6 showed no caller cares
about shared references, the 11-line ancestor tracking could become an 8-line `WeakSet` (M2 measures the cost).

## 4. Sub-decisions (not to be improvised)

1. **Circular placeholder:** exactly **`"[Circular]"`** — pinned by case 1's byte assertion `"self":"[Circular]"`.
2. **`BigInt` encoding:** `\`${value}n\`` — decimal digits + `n`, the JS literal spelling (`10n` → `"10n"`, `-3n` →
   `"-3n"`, `-0n` → `"0n"`). **Not** a marker object (`{"$bigint":"10"}` would change the shape of a field a reader
   greps and would nest). **Accepted, documented ambiguity:** a payload that *is* `"10n"` is indistinguishable —
   the file is not a wire format (falsifier 2), so this is stated, not solved. Pinned by case 2.
3. **Ancestors, not a seen-set:** track the **current path** (`ancestors` + `this`), so `{left: x, right: x}` serialises
   `x` twice instead of rewriting it. The alternative was measured: `"right":"[Circular]"`. Pinned by case 6 (kills M2).
4. **Fallback `data` = marker string, reason included:** `\`[unserializable data: ${faultReason(err)}]\``. The reason
   read is **guarded** (`faultReason`) — the caught value can be a Proxy whose `.message` access throws (measured:
   unguarded → `throws message getter blew up`; guarded → `"unknown fault"`). Rejected cheaper variant: marker with no
   reason (−8 lines) — after the replacer only *pathological* payloads reach the catch, so the reason is the only
   evidence of why. Pinned byte-exactly by cases 3, 4.
5. **`message` survives and is coerced:** the fallback spreads `entry` and overrides only `message`
   (`typeof entry.message === "string" ? … : "[unprintable message]"`) and `data`. Spreading keeps any future safe
   field; the coercion keeps the fallback **total** even for a JS caller passing a non-string message. Pinned by cases
   3, 4, 7 (original message bytes in the file).
6. **Helper location/shape:** three **module-local, non-exported** functions in a new
   `Serialisation (issue #545)` section between `resolveLogDir` and `createLogger`:
   `circularSafeReplacer(): (this: unknown, key: string, value: unknown) => unknown` — a **factory**, because the
   ancestor stack is per-call state — `faultReason(err: unknown): string`, `serializeEntry(entry: Record<string, unknown>): string`.
   The call site changes **one line**.
7. **Untouched:** `rotateIfNeeded`, `appendFileSync`, `resolveLogDir`, `LOG_LEVELS`, the level filter, the file
   `catch {}`. The fix sits above the sink; the sink keeps failing open.

## 5. The edit

### 5.1 `src/logging.ts` — helper section after `resolveLogDir` (`:130`), **+49**

```ts
// ---------------------------------------------------------------------------
// Serialisation (issue #545)
// ---------------------------------------------------------------------------

/**
 * #545: `data` is caller-supplied and `JSON.stringify` throws on a cycle and on a
 * `BigInt`. A cycle collapses to `[Circular]`, a `BigInt` to its decimal literal
 * (`10n`). Ancestors are tracked rather than every value ever seen, so `{a: x,
 * b: x}` — a shared reference, not a cycle — keeps both copies.
 */
function circularSafeReplacer(): (this: unknown, key: string, value: unknown) => unknown {
	const ancestors: unknown[] = [];
	return function (this: unknown, _key: string, value: unknown): unknown {
		if (typeof value === "bigint") return `${value}n`;
		if (typeof value !== "object" || value === null) return value;
		while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
		if (ancestors.includes(value)) return "[Circular]";
		ancestors.push(value);
		return value;
	};
}

/** #545: why a payload failed to serialise — guarded, because the caught value can
 * be a Proxy whose `.message` access throws too. */
function faultReason(err: unknown): string {
	try {
		const message = (err as { message?: unknown }).message;
		return typeof message === "string" && message !== "" ? message : "unknown fault";
	} catch {
		return "unknown fault";
	}
}

/** #545: the entry line, defensively. The replacer covers a cycle and a `BigInt`;
 * the catch covers what it cannot — a throwing `toJSON`, getter or Proxy trap.
 * `data` becomes a marker; the line and its `message` still reach the file. */
function serializeEntry(entry: Record<string, unknown>): string {
	try {
		return JSON.stringify(entry, circularSafeReplacer());
	} catch (err) {
		return JSON.stringify({
			...entry,
			message: typeof entry.message === "string" ? entry.message : "[unprintable message]",
			data: `[unserializable data: ${faultReason(err)}]`,
		});
	}
}
```

### 5.2 `src/logging.ts` — call site (`:153`), **−1**

```diff
-		const line = JSON.stringify(entry);
+		const line = serializeEntry(entry);
```

### 5.3 `src/session-manager.ts` — the now-false `safeLog` doc (**5/5, net 0**)

The block says “The entry build **can still throw** — `JSON.stringify` on cyclic `data` sits **outside** the sink's
catches (#545)”. After this edit that is false; shipping it is a docs-pinning violation. Replacement (verified:
`grep -rn "OUTSIDE its file-write\|cyclic \`data\` sits outside" src/ scripts/` → **0 hits**):

```ts
/**
 * Issue #450 (D5): a log call on an ERROR path must never replace the error it
 * reports — a throwing sink becomes the caller's error and skips every later
 * step of the cleanup. Both sink faults are now contained at the sink itself:
 * #543 the console mirror (swallowed like a file-write fault), #545 the entry
 * build (`JSON.stringify` on a cyclic or `BigInt` `data` used to throw). This
 * wrapper stays as belt-and-braces, local to the settle/pre-start paths, where
 * a third fault class would otherwise become the caller's error.
 */
```

`safeLog` is **not** retired: it wraps `log.*` on the settle paths and remains defence in depth. Net 0 → no allowance impact.

**Net source: +49/−1 = +48** (`logging.ts`) **+ 0** (`session-manager.ts`). No other file changes.

## 6. Tests — `logging.test.ts`, 17 → **24** (+111 lines)

No new imports, no `afterEach` change: #543 already provides `tempCwd()`/`readLog(cwd)` (`:24–37`), the temp-dir cleanup
(`:65`) and `freshLogger(level, consoleEnv, cwd?)` (`:76–85`). The new block goes after the last `#543` case.

| # | case | asserts | **red on base?** |
|---|---|---|---|
| 1 | `collapses a cyclic data payload to [Circular] and still logs it (#545)` | `not.toThrow()`; **exactly 1** mirror call `[test] INFO: cyclic payload`; file has `"data":{"a":1,"self":"[Circular]"}` + the message | **red** (`TypeError: Converting circular structure`) |
| 2 | `encodes a BigInt in data as its decimal literal (#545)` | `not.toThrow()`; `"data":{"count":"10n","neg":"-3n"}` | **red** (`Do not know how to serialize a BigInt`) |
| 3 | `emits a marker entry when a payload's own toJSON throws (#545)` | `not.toThrow()`; `"data":"[unserializable data: toJSON blew up]"` **and** the message | **red** (`Error: toJSON blew up`) |
| 4 | `emits a marker entry for a data Proxy whose traps throw (#545)` | `not.toThrow()`; `"data":"[unserializable data: get trap blew up]"` **and** the message | **red** (`Error: get trap blew up`) |
| 5 | `keeps the exact entry shape and key order for serialisable data (#545)` | one line; regex pins `"level":"info","prefix":"test","message":…,"data":{…}` order; `JSON.parse` deep-equals all five fields | **green** — ships because the replacer now runs on **every** entry and must not perturb shape/order |
| 6 | `keeps a shared non-circular reference intact — ancestor tracking, not a seen-set (#545)` | `"left":{"id":1},"right":{"id":1}` | **green** — identical bytes on base; ships because it is the **only** killer of **M2** |
| 7 | `keeps logging after a swallowed payload fault — same module instance (#545)` | fault call `not.toThrow()`, then a healthy call in the **same module instance**: `warnSpy` **2** calls (last = healthy), file has **both** lines | **red** (the first call throws) |

Case 7's payload is a **throwing getter**, deliberately not a cycle: after the fix a cycle never reaches the
whole-stringify `catch`, so a latch planted there would be invisible (measured: with a cyclic payload **M7 survives**,
`0F/24P`). The getter reaches the `catch` and makes the latch observable.

```ts
	it("keeps logging after a swallowed payload fault — same module instance (#545)", async () => {
		const cwd = tempCwd();
		// Reaches the whole-stringify catch (not the replacer), so a latch set there shows up.
		const hostile = {
			get boom(): string {
				throw new Error("getter blew up");
			},
		};
		const { log } = await freshLogger(undefined, "1", cwd);

		expect(() => log.warn("faulting payload", hostile)).not.toThrow();
		log.warn("healthy after fault");

		// No sticky degradation: one hostile payload must not disable later calls.
		expect(warnSpy).toHaveBeenCalledTimes(2);
		expect(warnSpy).toHaveBeenLastCalledWith("[test] WARN: healthy after fault");
		expect(readLog(cwd)).toContain("faulting payload");
		expect(readLog(cwd)).toContain("healthy after fault");
	});
```

Case 1 also pins the reversal #543 left to review: `mirrorCalls=1` where base measures `0`.

## 7. Mutants (each executed: `npx vitest run src/__tests__/logging.test.ts`, 24 cases)

| # | Mutant | Killed by | Measured |
|---|---|---|---|
| M1 | **no fix** (base source) | cases 1–4, 7 | **5F/19P** |
| M2 | `WeakSet` seen-set instead of ancestor tracking | case 6 **only** | **1F/23P** |
| M3 | replacer **without** the `BigInt` branch | case 2 **only** | **1F/23P** |
| M4 | fallback **drops the message** | cases 3, 4, 7 | **3F/21P** |
| M5 | fallback **writes nothing** (`return ""`) | cases 3, 4, 7 | **3F/21P** |
| M6 | fallback **reuses the raw `data`** (rethrows) | cases 3, 4, 7 | **3F/21P** |
| M7 | **sticky latch** — `minLevel = "error"` in the catch | case 7 **only** | **1F/23P** |
| M8 | **replacer only**, no whole-stringify fallback | cases 3, 4, 7 | **3F/21P** |

Control (fixed source): **0F/24P**. M8 is what earns the `catch` its lines — without it `toJSON`/getter/Proxy payloads
still escape; M3 shows the `BigInt` branch is not decoration.

## 8. Verification plan

1. **Targeted:** `npx vitest run src/__tests__/logging.test.ts` → **24 passed**.
2. **Base-vs-fixed capture** (the new tests must be red *on the base source*): revert `src/logging.ts` only, keep the
   new tests → **5 failed / 19 passed (24)** with exactly §6's red names; restore → 24 passed. Three-tree proof
   (scratch copy, no repo writes):

   | tree | source | tests | `logging.test.ts` | full suite | failed set |
   |---|---|---|---|---|---|
   | **A** clean base | base | base | 17 passed | **3059 tests, 28 failed** (copy artifacts) | A |
   | **B** test-patched base | base | new | **5F/19P (24)** | **3066 tests, 33 failed** | A + **5** |
   | **C** fixed | fix | new | **24 passed** | **3066 tests, 28 failed** | identical to A |

   `comm` on sorted failed `fullName`s: **B−A = 5** (the §6 names), **C−A = 0**, **A−C = 0**, **B−C = 5**, **C−B = 0**.
3. **Full suite** in-repo: record the clean-base failing set first, then compare — the *delta* is the claim (this tree's
   clean base should be **0 failed**; the copy's 28 are suites needing the real repo root/`.git`, equal in A and C).
4. **`npx tsc --noEmit`** → **exit 0** (measured on C, and again after §5.3).
5. **Repo guards** on C, all measured green: `check-imports.mjs` → `imports: 60 files, 0 violations`; `docs-arch.mjs` →
   `module map is current (60 modules)` (the `logging.ts` purpose line is unchanged); `check-readme-test-count.mjs` →
   `README says 3000+, suite ran 3066 — OK`; `check-test-budget.mjs <report>` → `wall 19.11s (<= 60.00s)`,
   `floors — src 60/60 reachable · scripts 13/13`, ratio `1.97` **reported** in the 1.95 band (not enforced), `OK.` exit 0.
6. **Flow gate at the committed head:** `node scripts/check-test-budget.mjs --flow --base dev --head <final sha>` →
   the line in §9, **exit 0**; paste line + `$?` into the PR body. Any amend invalidates the sha — re-run.
7. `git diff --check` clean; `git diff` touches exactly §5.1–§5.3.

## 9. Delta and the flow gate

| file | + | − | net |
|---|---|---|---|
| `src/logging.ts` (helper + call site) | 49 | 1 | **+48** |
| `src/session-manager.ts` (doc block) | 5 | 5 | **0** |
| **source net** | | | **+48** → allowance `120 + 2×48` = **216** |
| `src/__tests__/logging.test.ts` (7 cases) | 111 | 0 | **+111** → **within by 105** |

Measured with the real script, on a committed head carrying exactly this three-file diff:

```
$ node scripts/check-test-budget.mjs --flow --base 7ff0e6f --head c55c102
test-flow: +111/+48 src (allowance 216) — within (base 7ff0e6f)
$ echo $?
0
```

`--base` there is the scratch repo's base commit, not `dev`: the merge-time run against `dev` and the PR sha is the
gate (the same residue the #543 spec records).

## 10. Risks, residuals, out of scope

- **Entry shape.** Only `data` changes: a cycle → `"[Circular]"`, a `BigInt` → `"10n"`, and on the fallback path `data`
  becomes a string. The envelope never changes; serialisable payloads are byte-identical. No code parses the file, so
  this is readability, not a format break.
- **The file contract is unchanged and strictly better.** The sink keeps its `catch {}`; the new `catch` sits above it
  and **writes** a line instead of skipping one.
- **`safeLog`** corrected (§5.3), not retired; **#543's mirror** unregressed (all 17 pre-existing cases pass, and a
  hostile payload now reaches the mirror); **levels/rotation/`resolveLogDir`** untouched — the fallback runs after the
  level filter, so a suppressed level costs nothing.
- **Residuals (documented, not fixed):** a payload that *is* `"10n"`/`"[Circular]"` is ambiguous; a caller passing a
  non-`string` **message** gets `"[unprintable message]"` (type violation; the alternative is rethrowing); `-0n` → `"0n"`.
- **Out of scope:** levels, rotation, `MAX_LOG_*`, the entry-shape contract, `safeLog`'s removal, and the **17 other
  `JSON.stringify` sites in `src/`** — e.g. `session-manager.ts:532` agent persistence, already inside its own
  `try/catch` with a comment naming this fault class. Flagged, not fixed.

## 11. Acceptance criteria

1. All five hostile payloads return normally — cases 1–4, 7. **Falsifier:** any `not.toThrow()` red.
2. The file records a line for each hostile payload: `[Circular]`, `"10n"`, or a reason-carrying marker — cases 1–4,
   byte-exact. **Falsifier:** a byte mismatch or a missing line.
3. The mirror is attempted **exactly once** for a hostile-but-serialisable payload — case 1. **Falsifier:** 0 (today) or 2.
4. Serialisable `data` is byte-identical to base and keeps key order — case 5 + the 9/9 probe. **Falsifier:** any diff.
5. A shared non-circular reference is preserved — case 6; M2 must be red.
6. No sticky degradation after a fallback-path fault — case 7; M7 must be red.
7. `message` is never swallowed by the fallback — cases 3, 4, 7; M4 must be red.
8. No throw escapes the fallback itself — M6 must be red.
9. `npx tsc --noEmit` exits 0.
10. `git diff` touches only `src/logging.ts`, `src/__tests__/logging.test.ts`, the `src/session-manager.ts` doc block —
    and changes none of `rotateIfNeeded`, `appendFileSync`, `resolveLogDir`, `LOG_LEVELS`, the filter, the file
    `catch {}`. **Falsifier:** a hunk in any of them.
11. The flow gate at the committed head exits 0 with `+111/+48 src (allowance 216) — within`.
12. The full-suite failing set differs from the clean-base capture by exactly the **5** names of §6 and by **0** from the
    fixed tree. **Falsifier:** any only-in-fixed name.

## 12. Open questions for the conductor

1. **Case 7's payload (recommend: throwing getter).** A cyclic payload leaves M7 alive (`0F/24P`, measured) because the
   replacer handles it before the `catch`; the replacer path's liveness is instead pinned by case 1's mirror assertion.
2. **Marker carries the reason (recommend: yes).** Cutting `faultReason` saves 8 source lines (→ +40, allowance 208) and
   loses the only evidence of *why*; the read is guarded (a hostile `.message` yields `"unknown fault"`, not a throw).
3. **§5.3 belongs in this PR (recommend: yes).** Net 0, keeps docs pinned to the contract, and is the same edit #543
   made in the other direction. The alternative is a false comment surviving a third cycle.
4. **No user-facing doc change (recommend: none).** `[Circular]`/`"10n"`/the marker are documented in code comments;
   no docs guard covers `logging.ts` behaviour and no reader parses the file.

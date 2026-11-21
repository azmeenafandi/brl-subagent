# Implementation spec (**r3**) — #545: a cyclic/BigInt log `data` payload throws out of `log.*`

**Base:** `dev @ 22e1f77` · **Priority:** low · **C-level:** C2 · **Supersedes:** r2 (`21bd1a8`)
**r3 is a conductor edit** — the r2 critique returned **no majors** (5 minors), so the loop stopped; the changes are the five fixes plus the message-coercion case the critique showed was unpinned (`## r2 → r3 changes`).
**Decision:** serialise defensively — a cycle-collapsing + `BigInt`-encoding replacer, plus a whole-stringify `catch`
that emits a **marker entry whose `data` is an object** (option A). Measured three-file diff: **+55 net source**
(`logging.ts` +56/−1; `session-manager.ts` doc 5/5, net 0) / **+190 net test**, allowance `120 + 2×55` = **230** →
**within by 40** (§9).

Contract (this sentence is the `serializeEntry` doc comment in §5.1, word for word):
> The replacer covers a cycle and a `BigInt`; the catch covers what it cannot — a throwing `toJSON`, getter or Proxy trap.

## r1 → r2 changes

One row per r1-critique finding (`issue-545-plan-critique-r1-2026-11-21.md`), plus the case the measurements forced.

| # | Severity | r1 gap | r2 change | Where | Measured evidence for the resolution |
|---|---|---|---|---|---|
| 1 | **major** | The marker was a **string** (`"[unserializable data: <reason>]"`), and the log *is* parsed outside `src`/`scripts`; `sprint-metrics.read_spawn_starts` throws `AttributeError` on it (§3 falsifier 2 said "no reader") | `data` is now **`{ "[unserializable]": "<reason>" }`**; falsifier 2 names both consumers, and §10 states what each does with a marker | §3 fals. 2, §4.4, §5.1, §6 cases 3–7, §10, §11.2, §12.4 | Real logger marker line fed to the real consumers: `sprint-metrics.read_spawn_starts` → `background: 1` (r1 string shape → `AttributeError: 'str' object has no attribute 'get'`); duplicate marker entry (same timestamp) → `1`, two distinct timestamps → `2` (the `path:timestamp` fallback id of `sprint-metrics.py:600`); `jev-check --log` → exit 1 `spawn event carries no task payload — cannot audit` (healthy entry → exit 0) |
| 2 | **major** | r1 case 7 (now case **10**) asserted only the *message*, not the getter's marker; no case covered a thrown value whose `.message` getter throws (unguarded `faultReason` passed at **24P**); case 4's `get` trap fires before `ownKeys`, so the latter was untested | Case 10 now asserts `"data":{"[unserializable]":"getter blew up"}` **byte-exactly**; **new case 5** = `ownKeys`-only Proxy (`ownKeys trap blew up`); **new case 6** = fault whose `.message` getter throws (`unknown fault`) | §6 cases 5, 6, 10; §7 M9, M10, M11 | Base source + 27 tests: **8F/19P**; M9 (accessor special-case marker text) now killed by **2** cases (was green at 24P), M10 (unguarded reason read) killed by **exactly** case 6 (`1F/26P`), M11 (fallback enumerates payload keys) killed by **exactly** case 5 (`1F/26P`) |
| 3 | minor | Fallback totality was overstated for untyped JS callers (unchecked `prefix` spread back in → `TypeError: Do not know how to serialize a BigInt` **inside** the fallback, line lost); `-0n` stated as always encoded | `prefix` coerced like `message` (`"[unprintable prefix]"`); claim scoped to the logger's **typed API**; `-0n` sentence qualified (encoded only when reached through a truthy container); a healthy non-string `message` is stated to serialise **as-is** | §4.5, §5.1, §6 case 7, §10, §11.7 | M12 (fallback drops the prefix coercion) **survived all 26 cases at 0F**, so case 7 was added — M12 now `1F/26P`; on base that case is red with `TypeError: Do not know how to serialize a BigInt`. Probes on the fixed source: `{v:-0n}` → `"data":{"v":"0n"}`; direct `-0n`, `0n`, `""` → **no** `data` field; numeric message → `"message":42` |
| 4 | minor | The helper comment promised the line and its `message` "still reach the file" — no cwd means no write attempt, and the sink still swallows faults | Comment now says the line is **serialised and reaches a conditional file-write attempt**; persistence still depends on a configured cwd and on the sink | §5.1 (`serializeEntry` doc), §10 | Text only; no measurement. Matches `resolveLogDir()`'s conditional (`logging.ts:128–130`) and the sink's `catch {}` (`:236–238`) |
| 5 | minor | The recorded `--flow` head carried `logging.ts` + its test only (`+49/−1`, `+111`); the doc edit was net 0 in a different commit, so the run did not measure the three-file diff | `--flow` **re-run on a head carrying exactly the three files**; provenance of base/head stated; the merge-time run at the PR head against `dev` remains the gate | §8.6, §9 | Scratch head `54abe5e` (`+56/−1`, `+172/0`, doc `5/5` vs base `7ff0e6f`) → `test-flow: +172/+55 src (allowance 230) — within`, exit **0** |
| 6 | — (r2 self-found) | A green-claim without a killer: "a JS caller violating the types gets the placeholder" had no test, so M12 survived | Case 7 shipped **as a test**, not just as a code line; case count therefore **17 → 27** (not 26) | §6, §7 M12 | M12 `1F/26P` after the case; base `8F/19P` |

## r2 → r3 changes (conductor edit — loop stopped, r2 had no majors)

| r2 finding | Severity | r3 change | Where | Evidence |
|---|---|---|---|---|
| The flow head does not carry exactly three changed files; the scratch base is not the complete `dev` tree | minor | Provenance corrected: the head also adds a scratch `.development/ARCHITECTURE.md`, and the base is a 312-file **copy** of the `dev @ 22e1f77` tree (661 tracked files); the three files' numstat and the allowance arithmetic stand; the final-PR-head run against `dev` is the authority | §9 | `git diff --name-status 7ff0e6f 886710c` → the three files **plus** the scratch artifact |
| Case 7 pins prefix coercion, not message coercion; dropping the message coercion passed all 27 | minor | **Case 11** added (+18 lines): hostile data + a BigInt `message` → `"message":"[unprintable message]"` and the marker. New **M13** (drop the message coercion) | §6 case 11, §7 M13, §11.7 | fixed + 28 → **28P**; base + 28 → **9F/19P**; M13 → **1F/27P** (case 11 only) — measured in the r2 scratch harness |
| The consumer probes are results, not re-runnable commands | minor | **§8.8** added: the exact `read_spawn_starts` import snippet and the `jev-check --log` invocation, both against a fixture line | §8.8, §11.3 | commands run against the r2 fixture (marker → `{'background': 1, 'spawns': 1}`; jev-check → exit 1) |
| The timestamp fallback can merge two **different** marker spawns in the same millisecond | minor | Reworded: a duplicate line is deduped; two distinct markers sharing a timestamp merge to **one** (a degraded-input undercount), not "each entry counts once" | §4.4, §10 | `read_spawn_starts` probe: same timestamp → 1, distinct → 2 |
| "Encoding is reachable only through a truthy container" is wrong for a direct truthy BigInt | minor | Reworded: only a **falsy** root `data` is dropped (`0n`, `-0n`, `""`); a truthy root `10n` is encoded to `"10n"` | §4.2 | real fixed-logger call: `data: 10n` → `"data":"10n"`; `data: -0n` → no `data` |

## 1. Context and the measured defect

`log()` serialises **before** every guard: filter `:142`, `entry` `:145–151`, `JSON.stringify(entry)` **`:153`**, mirror
`:157–168` (#543's `try`), file sink `:172–184`. A `data` that `JSON.stringify` refuses throws **out of `log.*`** — and
because serialisation precedes the mirror, it also suppresses the mirror and the write. Measured with the **real**
`src/logging.ts` (`~/.cache/brl-subagent/scratch/spec-545/probe-base-r2.ts`, node 24 strip-types, `mkdtemp` cwd per case),
re-run for r2 on the unchanged base copy:

| `data` payload | `log.info` on **base** | file | mirror (on) |
|---|---|---|---|
| cyclic `{a:1, self:⤴}` | **throws** `TypeError: Converting circular structure to JSON…` | **absent** | **0 calls** |
| `{n: 10n}` | **throws** `TypeError: Do not know how to serialize a BigInt` | absent | 0 calls |
| throwing `toJSON()` | **throws** `Error: toJSON blew up` | absent | 0 calls |
| throwing getter | **throws** `Error: getter blew up` | absent | 0 calls |
| Proxy (`ownKeys`/`get` throw) | **throws** `Error: get trap blew up` | absent | 0 calls |
| healthy payload | returns | one line, exact shape | 1 call |
| healthy call **after** a fault, same module instance | returns, logs | one line | – (**no** sticky state on base) |

**Fixed tree, same probe** (`probe-fixed.ts` against the r2 source): every row returns normally and the file gets its line —
cyclic → `{"a":1,"self":"[Circular]"}`; `10n` → `{"n":"10n"}`; `toJSON`/getter/Proxy → `{"[unserializable]":"<reason>"}`
(`toJSON blew up`, `getter blew up`, `get trap blew up`); cyclic + mirror ON → **1** mirror call; healthy payload →
**byte-identical** to base. The retry row writes **both** lines in the same module instance.

Zero-regression on normal payloads re-measured (`probe-identical.ts`): **9 of 9** realistic serialisable payloads (date,
`undefined`/`null`, nested arrays, error-shaped object, deep object, empty object, array root, `toJSON` object, nested
shared reference) serialise **byte-identically** with the replacer.

Three rows the r1 table lacked, measured for r2 (§4.5): `{v:-0n}` → `{"v":"0n"}`; a **direct falsy root** `data` (`0n`,
`-0n`, `""`) → the `data` field is **omitted** (the pre-existing truthiness check at `:150`/`:205`, not the replacer);
a healthy call with a numeric `message` → `"message":42` as-is.

## 2. Recon (Rule 13 — codegraph @ 22e1f77)

Carried from r1 against the **same base tree**; r2 adds only module-local, non-exported functions, so no caller or
impact edge can move (the diff touches one call site inside `createLogger`).

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

**Verification of the code facts** (all re-read on this tree; line numbers are base `22e1f77` — the r2 helper block
shifts them by +56 below `:130`):

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | `logging.ts` is 221 lines | **Confirmed** | `wc -l src/logging.ts` → `221` (r2 scratch: 276) |
| 2 | Body order = filter → `entry` → stringify → mirror → logDir → `try{mkdir,rotate,append}catch{}` | **Confirmed**, bounds: filter **142**, `entry` **145–151**, stringify **153**, mirror **157–168**, `logDir` **172**, `try` **174–183** | `nl -ba src/logging.ts \| sed -n '137,195p'` |
| 3 | The unguarded stringify also suppresses the mirror | **Confirmed, measured** | §1 row 1: `mirrorCalls=0` with the mirror on |
| 4 | `logging.test.ts` 300 lines / 17 cases, `resetModules` + `tempCwd`/`readLog` + `freshLogger(level, consoleEnv, cwd?)` returning `{mod, log}` | **Confirmed** | `wc -l` → `300`; `grep -c "^\s*it("` → **17**; helpers **24–37**, cleanup **65**, `freshLogger` **76–85** |
| 5 | `safeLog` documents the “never crash” premise and names #545 | **Confirmed** — doc **163–171**, `function safeLog` **172**, `#545` on **169** | `grep -n "function safeLog\|#545" src/session-manager.ts` |
| 6 | 22 raw `createLogger` hits | **Confirmed, reconciled exactly**: 20 non-test + 2 test = **22** = 1 definition (`logging.ts:137`) + 7 imports + **7 call sites** + 5 comments (`logging.ts:9,113,171`, `runtime.ts:11`, `index.ts:239`) + 2 test mentions | `grep -rn "createLogger" src --include=*.ts \| grep -v __tests__` → **20**; `grep -rn "createLogger" src/__tests__` → **2** |
| 7 | Recon's “14 callers” | **Confirmed** = 7 call sites + 7 import edges (`transcript:5`, `scratch-spawn:51`, `session-manager:32`, `runtime:25`, `event-bus:3`, `store-permissions:25`, `runner:46`). Grep added **no** call site the graph missed; the 5 comments + the definition are why grep reads 20 | same greps, `cat -n` |
| 8 | The defect is `data`-shaped, not entry-shaped | **Confirmed** — the other four fields are `string`/`LogLevel` written by `log()` itself | §1: all five hostile shapes live inside `data` |

## 3. Options

Each measured against the **same 27-case** `logging.test.ts` (§6), in `~/.cache/brl-subagent/scratch/spec-545/repo`
(rsync copy of `dev @ 22e1f77`, `node_modules` symlinked). Base **8F/19P**, fixed **27P/0F** on the 27-case set; r3's case 11 is red on base and green on the fix, so the final set is **9F/19P → 28P** (§7).

| # | Option | Mechanism | Blast radius | Cost | Risk if wrong | Verified |
|---|---|---|---|---|---|---|
| **A** | **Defensive serialisation** (recommended) | `serializeEntry(entry)` = `JSON.stringify(entry, circularSafeReplacer())` — cycle → `[Circular]`, `BigInt` → `` `${v}n` `` — in one `catch` that re-emits the entry with `data: { "[unserializable]": faultReason(err) }` | `logging.ts`; every call, `data` only | +56/−1 source, +172 test | a cycle becomes a string; the pathological payload loses its body (the marker still says why and stays readable by `data.<field>` consumers) | **27P/0F**; 9/9 normal payloads byte-identical |
| B | Drop the unserializable `data` | no replacer; `catch` re-emits `{…entry, data: "[unserializable]"}` | same | ~+12 | a **cycle** and a **BigInt** — the two shapes the issue names — each lose the whole payload, the marker cannot say which, **and** the marker is a string (breaks `read_spawn_starts`) | **8F/19P** — cases 1–6, 7, 10 red; every fallback case is red because the marker shape and reason are unusable |
| C | Wrap the whole `log()` body in one `try/catch` | outer `try` over filter→entry→stringify→mirror→write | all of `log()` | +3/−1 | **loses the line entirely** (the throw precedes mirror and write) — the issue's own observable fails; mutes every future sink fault with no comment | **8F/19P** (same red set as base) |
| D | Reorder: serialise after the mirror | move `line` below `:168` | every call | ~0 | the mirror is fixed, the throw still escapes | **8F/19P** (verified: stringify at offset 6255 vs mirror at 5689) |
| E | Do nothing | — | — | 0 | `safeLog`'s premise stays false at 100 % of `log.*` sites; the settle/deadline catch-alls keep assuming totality | **8F/19P** (= M1) |

**Recommendation: A** — the only option where every reported shape returns normally **and** still records the line, the
only one that keeps partial detail (`[Circular]`, `"10n"`) for the two shapes the issue names, and the only one whose
fallback entry is still parseable by `sprint-metrics`.

**Falsifiers.** (1) If cycles/`BigInt` were unreachable from real call sites, E/B would be proportionate — not the case:
`data` is `Record<string, unknown>` at 7 call sites, and `err`/`agent`/`result` objects are passed directly. (2) If the
marker entry broke a **supported consumer**, the shape would have to change again — measured: the object marker keeps
`sprint-metrics.read_spawn_starts` working (`background: 1`) where r1's string marker threw `AttributeError`;
`jev-check --log` fails closed on a marker of either shape (exit 1, §10), which is the correct posture for a destroyed
dispatch payload, and is unreachable from the tooling's own spawn entries (all-string payloads, §10). (3) If case 9 showed
no caller cares about shared references, the 11-line ancestor tracking could become an 8-line `WeakSet` (M2 measures the
cost).

## 4. Sub-decisions (not to be improvised)

1. **Circular placeholder:** exactly **`"[Circular]"`** — pinned by case 1's byte assertion `"self":"[Circular]"`.
2. **`BigInt` encoding:** `` `${value}n` `` — decimal digits + `n`, the JS literal spelling (`10n` → `"10n"`, `-3n` →
   `"-3n"`, `-0n` → `"0n"`). **Not** a marker object (`{"$bigint":"10"}` would change the shape of a field a reader
   greps and would nest). **Accepted, documented ambiguity:** a payload that *is* `"10n"` is indistinguishable — the file
   is not a versioned wire format, so this is stated, not solved. Pinned by case 2.
   **Precision (r3):** only a **falsy** root `data` is dropped — `log()` omits it via `...(data ? { data } : {})`
   (`:205`) **before** the replacer runs, so `log.info(msg, -0n)` and `log.info(msg, 0n)`/`""` write no `data` field
   (measured). A truthy root is passed through and encoded: `log.info(msg, 10n)` → `"data":"10n"` (measured), and
   `{v:-0n}` → `"data":{"v":"0n"}`.
3. **Ancestors, not a seen-set:** track the **current path** (`ancestors` + `this`), so `{left: x, right: x}` serialises
   `x` twice instead of rewriting it. The alternative was measured: `"right":"[Circular]"`. Pinned by case 9 (kills M2).
4. **Fallback `data` = an object marker, reason included:** `{ "[unserializable]": faultReason(err) }`. **Why an object
   and not a string (r2):**
   - `sprint-metrics.py::read_spawn_starts` (`:598–600`) does `data = d.get("data") or {}` then `data.get("agentId") or
     f"{path}:{timestamp}"`. With an object, `.get` returns `None` and the entry counts under the timestamp fallback
     id (measured: `background: 1`; same-timestamp duplicate → `1`; two distinct timestamps → `2`). The fallback id is
     not unique: two **different** marker entries in the same millisecond merge to one — a degraded-input undercount,
     stated in §10. With r1's
     string, `.get` does not exist: `AttributeError: 'str' object has no attribute 'get'`, aborting the whole reconcile.
   - The reason value is still a **string**, so a reader that greps `unserializable` finds it, and a reader that only
     reads `data.<field>` degrades to `undefined` instead of throwing.
   - The reason read is **guarded** (`faultReason`): the caught value can be a Proxy whose `.message` access throws.
     Measured: unguarded → the raw `Error: message getter blew up` escapes `log.*` (base, and M10 on the fixed source);
     guarded → `"unknown fault"`. Pinned byte-exactly by cases 3, 4, 5, 6, 10.
5. **`prefix`/`message` survive and are coerced; the totality claim is scoped to the typed API (r2):**
   `prefix` and `message` are `string` in `Logger`/`createLogger`'s signature, so for every **typed** caller the fallback
   is total by construction. A JS caller that violates the type gets the placeholder **on the fallback path** —
   `typeof entry.prefix === "string" ? … : "[unprintable prefix]"` and likewise `"[unprintable message]"` — which is why
   the coercion is there: the spread would otherwise put the raw value back into a second `JSON.stringify`, and an
   unprintable one throws *inside* the fallback, losing the line (measured on base: `createLogger(10n, cwd)` +
   a throwing getter → `TypeError: Do not know how to serialize a BigInt`; M12 on the fixed source → case 7 red).
   On the **healthy** path no coercion happens: `log.info(42 as unknown as string)` writes `"message":42` (measured).
   Pinned by cases 3, 4, 5, 6, 7, 10.
6. **Helper location/shape:** three **module-local, non-exported** functions in a new
   `Serialisation (issue #545)` section between `resolveLogDir` and `createLogger`:
   `circularSafeReplacer(): (this: unknown, key: string, value: unknown) => unknown` — a **factory**, because the
   ancestor stack is per-call state — `faultReason(err: unknown): string`, `serializeEntry(entry: Record<string, unknown>): string`.
   The call site changes **one line**.
7. **Untouched:** `rotateIfNeeded`, `appendFileSync`, `resolveLogDir`, `LOG_LEVELS`, the level filter, the file
   `catch {}`. The fix sits above the sink; the sink keeps failing open. Whether a line reaches a *file* is still
   conditional on a configured cwd — the comment says "conditional file-write attempt", never "reaches the file".

## 5. The edit

### 5.1 `src/logging.ts` — helper section after `resolveLogDir` (`:130`), **+56** (55 lines + the separating blank)

```ts
// ---------------------------------------------------------------------------
// Serialisation (issue #545)
// ---------------------------------------------------------------------------

/**
 * #545: `data` is caller-supplied and `JSON.stringify` throws on a cycle and on a
 * `BigInt`. A cycle collapses to `[Circular]`, a `BigInt` to its decimal literal
 * (`10n`, and `-0n` to `"0n"`). Ancestors are tracked rather than every value ever
 * seen, so `{a: x, b: x}` — a shared reference, not a cycle — keeps both copies.
 * The replacer only sees values JSON reaches: a falsy root `data` (`0n`, `-0n`,
 * `""`) is dropped by `log()`'s truthiness check before serialisation.
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
 * `data` becomes an object marker, `{"[unserializable]": reason}`: an object keeps
 * every consumer that reads `data.<field>` alive (`missing → undefined`), where a
 * string would crash one. The line is serialised and reaches the conditional
 * file-write attempt below; whether a file exists still depends on a configured
 * cwd and on the sink, which keeps swallowing its own faults. */
function serializeEntry(entry: Record<string, unknown>): string {
	try {
		return JSON.stringify(entry, circularSafeReplacer());
	} catch (err) {
		return JSON.stringify({
			...entry,
			prefix: typeof entry.prefix === "string" ? entry.prefix : "[unprintable prefix]",
			message: typeof entry.message === "string" ? entry.message : "[unprintable message]",
			data: { "[unserializable]": faultReason(err) },
		});
	}
}
```

### 5.2 `src/logging.ts` — call site (`:205` in the fixed file, `:153` in base), **−1**

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

**Net source: +56/−1 = +55** (`logging.ts`) **+ 0** (`session-manager.ts`). No other file changes.

## 6. Tests — `logging.test.ts`, 17 → **28** (+190 lines)

No new imports, no `afterEach` change, no `freshLogger` change: #543 already provides `tempCwd()`/`readLog(cwd)`
(`:24–37`), the temp-dir cleanup (`:65`) and `freshLogger(level, consoleEnv, cwd?)` returning `{mod, log}` (`:76–85`).
The new block goes after the last `#543` case (base `:300`, head `:301`).

| # | case | asserts | **red on base?** |
|---|---|---|---|
| 1 | `collapses a cyclic data payload to [Circular] and still logs it (#545)` | `not.toThrow()`; **exactly 1** mirror call `[test] INFO: cyclic payload`; file has `"data":{"a":1,"self":"[Circular]"}` + the message | **red** (`TypeError: Converting circular structure`) |
| 2 | `encodes a BigInt in data as its decimal literal (#545)` | `not.toThrow()`; `"data":{"count":"10n","neg":"-3n"}` | **red** (`Do not know how to serialize a BigInt`) |
| 3 | `emits a marker entry when a payload's own toJSON throws (#545)` | `not.toThrow()`; `"data":{"[unserializable]":"toJSON blew up"}` **and** the message | **red** (`Error: toJSON blew up`) |
| 4 | `emits a marker entry for a data Proxy whose toJSON get trap throws (#545)` | `not.toThrow()`; `"data":{"[unserializable]":"get trap blew up"}` **and** the message | **red** (`Error: get trap blew up`) |
| 5 | `emits a marker entry for a data Proxy whose ownKeys trap throws (#545)` **(new)** | `not.toThrow()`; `"data":{"[unserializable]":"ownKeys trap blew up"}` **and** the message | **red** (`Error: ownKeys trap blew up`) |
| 6 | `falls back to unknown fault when the fault's own .message getter throws (#545)` **(new)** | `not.toThrow()`; `"data":{"[unserializable]":"unknown fault"}` **and** the message | **red** (`Error: message getter blew up` escapes `log.*`) |
| 7 | `coerces a non-string prefix on the fallback path and keeps the line (#545)` **(new)** | `not.toThrow()`; `"prefix":"[unprintable prefix]"` **and** `"data":{"[unserializable]":"getter blew up"}` | **red** (`TypeError: Do not know how to serialize a BigInt`) |
| 8 | `keeps the exact entry shape and key order for serialisable data (#545)` | one line; regex pins `"level":"info","prefix":"test","message":…,"data":{…}` order; `JSON.parse` deep-equals all five fields | **green** — ships because the replacer now runs on **every** entry and must not perturb shape/order |
| 9 | `keeps a shared non-circular reference intact — ancestor tracking, not a seen-set (#545)` | `"left":{"id":1},"right":{"id":1}` | **green** — identical bytes on base; ships because it is the **only** killer of **M2** |
| 10 | `keeps logging after a swallowed payload fault — same module instance (#545)` | fault call `not.toThrow()`; **byte-exact marker** `"data":{"[unserializable]":"getter blew up"}`; then a healthy call in the **same module instance**: `warnSpy` **2** calls (last = healthy), file has **both** lines | **red** (the first call throws) |
| 11 | `coerces a non-string message on the fallback path and keeps the line (#545)` **(r3)** | `not.toThrow()`; `"message":"[unprintable message]"` **and** `"data":{"[unserializable]":"getter blew up"}` | **red** (`TypeError: Do not know how to serialize a BigInt` — the message is spread back into the fallback) |

Base source + these 28 tests: **9F/19P** (the 9 reds above; 19 = 17 pre-existing + cases 8, 9).

Case 10's payload is a **throwing getter**, deliberately not a cycle: after the fix a cycle never reaches the
whole-stringify `catch`, so a latch planted there would be invisible (measured in r1: with a cyclic payload **M7
survives**, `0F`). The getter reaches the `catch` and makes the latch observable. Its marker assertion also makes M9
(the accessor special-case marker text) killable — M9 dies on exactly cases 7 and 10, precisely because both use this
payload — and adds a second death for M9b/M4/M5/M6/M8.

Case 4 is a **`get` trap only** (no `ownKeys`), so it pins the `toJSON` lookup path; case 5 is an **`ownKeys`-only**
Proxy, which is a distinct throw site (`[[OwnPropertyKeys]]`) and the only killer of M11.

```ts
	it("emits a marker entry for a data Proxy whose `ownKeys` trap throws (#545)", async () => {
		const cwd = tempCwd();
		// No `get` trap: the `toJSON` lookup succeeds (undefined) and the fault lands on
		// [[OwnPropertyKeys]] instead — a distinct path from the `get` case above.
		const hostile = new Proxy(
			{ a: 1 },
			{
				ownKeys() {
					throw new Error("ownKeys trap blew up");
				},
			},
		);
		const { log } = await freshLogger(undefined, undefined, cwd);

		expect(() => log.info("ownKeys payload", hostile as Record<string, unknown>)).not.toThrow();
		expect(readLog(cwd)).toContain('"data":{"[unserializable]":"ownKeys trap blew up"}');
		expect(readLog(cwd)).toContain("ownKeys payload");
	});

	it("falls back to `unknown fault` when the fault's own `.message` getter throws (#545)", async () => {
		const cwd = tempCwd();
		// The thrown value is not an Error: reading `.message` throws, so an unguarded
		// reason read would re-throw out of `log.*` from inside the fallback itself.
		const hostileFault = {
			get message(): string {
				throw new Error("message getter blew up");
			},
		};
		const { log } = await freshLogger(undefined, undefined, cwd);

		expect(() =>
			log.info("hostile fault", {
				toJSON() {
					throw hostileFault;
				},
			}),
		).not.toThrow();
		expect(readLog(cwd)).toContain('"data":{"[unserializable]":"unknown fault"}');
		expect(readLog(cwd)).toContain("hostile fault");
	});

	it("coerces a non-string prefix on the fallback path and keeps the line (#545)", async () => {
		const cwd = tempCwd();
		// `prefix` is typed `string`; a JS caller can still violate it. Without the
		// coercion the raw value is spread back into the marker entry, so a BigInt
		// prefix throws *inside* the fallback and the line is lost.
		const hostile = {
			get boom(): string {
				throw new Error("getter blew up");
			},
		};
		const { mod } = await freshLogger(undefined, undefined, cwd);
		const log = mod.createLogger(10n as unknown as string, cwd);

		expect(() => log.info("bad prefix", hostile)).not.toThrow();
		expect(readLog(cwd)).toContain('"prefix":"[unprintable prefix]"');
		expect(readLog(cwd)).toContain('"data":{"[unserializable]":"getter blew up"}');
	});

	it("coerces a non-string message on the fallback path and keeps the line (#545)", async () => {
		const cwd = tempCwd();
		// `message` is typed `string`; a JS caller can still violate it. Without the
		// coercion the raw value is spread back into the marker entry, so a BigInt
		// message throws *inside* the fallback and the line is lost.
		const hostile = {
			get boom(): string {
				throw new Error("getter blew up");
			},
		};
		const { log } = await freshLogger(undefined, undefined, cwd);

		expect(() => log.info(10n as unknown as string, hostile)).not.toThrow();
		expect(readLog(cwd)).toContain('"message":"[unprintable message]"');
		expect(readLog(cwd)).toContain('"data":{"[unserializable]":"getter blew up"}');
	});
```

Case 1 also pins the reversal #543 left to review: `mirrorCalls=1` where base measures `0`.

The retry case (case 10) is r1's — payload, `warnSpy` counts and both file assertions unchanged — plus this
insertion after the `not.toThrow()` line. It is the only change r1→r2 in that case, and it is what makes M9/M9b red on
the getter path:

```diff
		expect(() => log.warn("faulting payload", hostile)).not.toThrow();
+		// r2: the getter path keeps its own byte-exact marker — a marker-text regression
+		// on this path must be red here, not only on the `toJSON` case.
+		expect(readLog(cwd)).toContain('"data":{"[unserializable]":"getter blew up"}');
		log.warn("healthy after fault");
```

## 7. Mutants (each executed: `npx vitest run src/__tests__/logging.test.ts`, **28 cases**)

Re-run in full against the r2 source (`mutants-r2.py`, report `mutant-r2.json`); M1–M8 re-run because the marker shape
and the case set moved, M9–M12 are new for the paths the critique found unpinned.

| # | Mutant | Killed by | Measured |
|---|---|---|---|
| M1 | **no fix** (base source) | cases 1–7, 10, 11 | **9F/19P** |
| M2 | `WeakSet` seen-set instead of ancestor tracking | case 9 **only** | **1F/26P** |
| M3 | replacer **without** the `BigInt` branch | cases 2, 7 | **2F/25P** |
| M4 | fallback **drops the message** (`"swallowed"`) | cases 3, 4, 5, 6, 10 | **5F/22P** |
| M5 | fallback **writes nothing** (`return ""`) | cases 3, 4, 5, 6, 7, 10 | **6F/21P** |
| M6 | fallback **reuses the raw `data`** (no marker override) | cases 3, 4, 5, 6, 7, 10 | **6F/21P** |
| M7 | **sticky latch** — `minLevel = "error"` in the catch | case 10 **only** | **1F/26P** |
| M8 | **replacer only**, no whole-stringify fallback | cases 3, 4, 5, 6, 7, 10 | **6F/21P** |
| M9 | accessor special-case — the `boom` getter path emits `"getter fault"` instead of the real reason (r2: marker **text** is now pinned) | cases 7, 10 | **2F/25P** |
| M9b | marker reason is a **constant** (`"serialisation failed"`) | cases 3, 4, 5, 6, 7, 10 | **6F/21P** |
| M10 | **unguarded reason read** — `data: { "[unserializable]": (err as Error).message }` | case 6 **only** | **1F/26P** |
| M11 | (instrument) fallback **enumerates the payload's keys** before building the marker | case 5 **only** | **1F/26P** |
| M12 | fallback **drops the `prefix` coercion** | case 7 **only** | **1F/27P** |
| M13 | fallback **drops the `message` coercion** (`message: entry.message`) | case 11 **only** | **1F/27P** |

Control (fixed source): **0F/28P**. Every mutant is killed, and the three new pins each have exactly one killer:
M10 ← case 6, M11 ← case 5, M12 ← case 7. M9 and M9b (the marker-text mutants) are killed by 2 and 6 cases respectively,
which is what r1 lacked: at 24 cases, replacing the getter's marker text still measured **24P**.

M8 is what earns the `catch` its lines — without it `toJSON`/getter/Proxy payloads still escape; M3 shows the `BigInt`
branch is not decoration; M2 shows the ancestor stack is not a seen-set with extra steps.

## 8. Verification plan

1. **Targeted:** `npx vitest run src/__tests__/logging.test.ts` → **28 passed** (measured: control run `0F/28P`).
2. **Base-vs-fixed capture** (the new tests must be red *on the base source*): revert `src/logging.ts` only, keep the
   new tests → **9 failed / 19 passed (28)** with exactly §6's red names — measured, including
   `Error: message getter blew up` surfacing on case 6 (the thrown value's `.message` read throws, so the throw escaping
   `log.*` is itself hostile) and `TypeError: Do not know how to serialize a BigInt` on case 7; restore → 27 passed. Three-tree proof (scratch copy, no repo writes), re-measured for r2:

   | tree | source | tests | `logging.test.ts` | full suite | failed set |
   |---|---|---|---|---|---|
   | **A** clean base | base | base | 17 passed | **3059 tests, 27 failed** (copy artifacts) | A |
   | **B** test-patched base | base | new | **9F/19P (28)** | **3070 tests, 36 failed** | A + **9** |
   | **C** fixed | fix | new | **28 passed** | **3070 tests, 27 failed** | identical to A |

   `comm` on sorted failed `fullName`s: **B−A = 9** (the §6 names), **C−A = 0**, **A−C = 0**, **B−C = 9**, **C−B = 0**.
   The 27 copy-artifact failures in A/C are suites that need the real repo root/`.git` (r1 recorded 28 on the same
   tree; the count is environment-dependent — the **delta** is the claim, and it does not move).
3. **Full suite** in-repo: record the clean-base failing set first, then compare — the *delta* is the claim (this tree's
   clean base should be **0 failed**).
4. **`npx tsc --noEmit`** → **exit 0** (measured on C, and again after §5.3).
5. **Repo guards** on C, all measured green: `check-imports.mjs` → `imports: 60 files, 0 violations`; `docs-arch.mjs` →
   `module map is current (60 modules)` (the `logging.ts` purpose line is unchanged); `check-readme-test-count.mjs <report>`
   → `README says 3000+, suite ran 3070 — OK`; `check-test-budget.mjs <report>` → `wall 20.70s (<= 60.00s)`,
   `floors — src 60/60 reachable · scripts 13/13`, ratio `1.97` **reported** in the 1.95 band (not enforced), `OK.` exit 0.
6. **Flow gate at the committed head:** `node scripts/check-test-budget.mjs --flow --base dev --head <final sha>` →
   the line in §9, **exit 0**; paste line + `$?` into the PR body. Any amend invalidates the sha — re-run.
7. `git diff --check` clean; `git diff` touches exactly §5.1–§5.3.
8. **Consumer probes (re-runnable from a checkout), on a marker fixture line:**
   ```bash
   FIX="$HOME/.cache/brl-subagent/scratch/spec-545/spawn-fixture.log"
   printf '%s\n' '{"timestamp":"2026-11-21T00:00:00.000Z","level":"info","prefix":"background-pipeline","message":"Background agent spawned","data":{"[unserializable]":"getter blew up"}}' > "$FIX"
   python3 - "$FIX" <<'PY'
   import importlib.util, sys
   spec = importlib.util.spec_from_file_location("sm", ".pi/skills/worktree/sprint-metrics.py")
   sm = importlib.util.module_from_spec(spec); spec.loader.exec_module(sm)
   print(sm.read_spawn_starts([sys.argv[1]], "2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z"))
   PY   # expect {'background': 1, 'spawns': 1, ...} — no exception
   node .pi/skills/worktree/jev-check.mjs --log "$FIX"; echo "exit=$?"   # expect exit 1, "no task payload"
   ```

## 9. Delta and the flow gate

| file | + | − | net |
|---|---|---|---|
| `src/logging.ts` (helper + call site) | 56 | 1 | **+55** |
| `src/session-manager.ts` (doc block) | 5 | 5 | **0** |
| **source net** | | | **+55** → allowance `120 + 2×55` = **230** |
| `src/__tests__/logging.test.ts` (11 cases) | 190 | 0 | **+190** → **within by 40** |

Measured with the real script on a scratch head (r3 correction — the head also adds a scratch
`.development/ARCHITECTURE.md`, excluded from the numstat below; the r1 head carried `logging.ts` + its test only):

```
$ git -C ~/.cache/brl-subagent/scratch/spec-545/repo diff --numstat 7ff0e6f 886710c
190	0	src/__tests__/logging.test.ts
56	1	src/logging.ts
5	5	src/session-manager.ts
$ node scripts/check-test-budget.mjs --flow --base 7ff0e6f --head 886710c
test-flow: +190/+55 src (allowance 230) — within (base 7ff0e6f)
$ echo $?
0
```

**Provenance, stated honestly:** `--base 7ff0e6f` is the scratch repo's base commit (a **312-file copy** of the
`dev @ 22e1f77` tree, which has 661 tracked files), not `dev` itself; `886710c` is a scratch commit, not the PR head;
and the head adds a scratch `.development/ARCHITECTURE.md` besides the three files. The numstat above is the three
files only. This run therefore proves the *allowance
arithmetic against the real diff shape*; it is **an estimate of, not a substitute for,** the merge gate. The
final-PR-head run (`--flow --base dev --head <pr sha>`) replaces it, and its output goes in the PR body unedited.

## 10. Risks, residuals, out of scope

**The log is read by two consumers outside `src`/`scripts` (r1 was wrong to say "no code parses the file").** Both were
fed a real marker entry produced by the fixed logger:

| consumer | reads | on a marker entry | measured |
|---|---|---|---|
| `.pi/skills/worktree/sprint-metrics.py::read_spawn_starts` (`:598–600`) | `d.get("data") or {}` → `data.get("agentId") or f"{path}:{timestamp}"` | the entry counts under the timestamp fallback id (degraded, not fatal); two **different** markers in the same millisecond merge to one — an undercount on degraded input | object marker → `{'background': 1, 'spawns': 1}`; same-timestamp duplicate → `1`; two distinct timestamps → `2`. **r1's string marker** → `AttributeError: 'str' object has no attribute 'get'` (the reconcile aborts) |
| `.pi/skills/worktree/jev-check.mjs::parseDispatchEvents` (`:466,470`) → `analyzeDispatchLog` (`:714`) | `entry.data?.task`, then `typeof task === "string" ? task : null`; `task === null` is a finding | **fails closed**: exit 1, `spawn event carries no task payload — cannot audit` | marker (either shape) → exit 1; healthy spawn entry → `every task carries a valid Rule 22 line`, exit 0 |

**Why `jev-check`'s fail-closed posture is right, and why the path is unreachable from the tooling's own entries.** A
dispatch whose task payload was destroyed must never pass the audit — a marker is exactly the evidence that the payload is
gone, so "cannot audit" is the correct verdict and the reason is in the entry itself. And the tooling cannot produce one:
the only info-level `Background agent spawned` writer is `src/background-pipeline.ts:778`, with
`{ agentId: identity.id, task: spawn.task, model: identity.model }` — all three are `string` (`BackgroundAgentIdentity`
`src/types.ts:908,913`; `BackgroundAgentSpawnRequest.task: string` `src/background-pipeline.ts:122`). Strings always
serialise, so the `catch` is unreachable there; a marker requires a caller breaking the type. The `warn` variant
(`:883`, different message) is ignored by both consumers. Note also that on base that call site's throw is swallowed by
`recordTailFailure("spawn log", err)` (`:779–781`) and the **entry disappears entirely** — after the fix the entry
survives as an *unauditable* line instead of a *missing* one. Both fail closed; the marker is the more auditable failure.

- **Entry shape.** Only `data` changes: a cycle → `"[Circular]"`, a `BigInt` → `"10n"`, and on the fallback path `data`
  becomes `{"[unserializable]":"<reason>"}`. The envelope never changes; serialisable payloads are byte-identical (9/9).
  The marker's shape is now chosen **for** the consumers, not just for readability.
- **The file contract is unchanged and strictly better.** The sink keeps its `catch {}`; the new `catch` sits above it
  and produces a line for the conditional file-write attempt instead of skipping one.
- **`safeLog`** corrected (§5.3), not retired; **#543's mirror** unregressed (all 17 pre-existing cases pass, and a
  hostile payload now reaches the mirror); **levels/rotation/`resolveLogDir`** untouched — the fallback runs after the
  level filter, so a suppressed level costs nothing.
- **Residuals (documented, not fixed):**
  - a payload that *is* `"10n"`/`"[Circular]"` is ambiguous with an encoded one;
  - a **typed** caller can never hit the coercions; an untyped one gets `"[unprintable prefix]"`/`"[unprintable message]"`
    **on the fallback path only** (a healthy call keeps a non-string value as-is — measured `"message":42`), which is
    the alternative to rethrowing inside the fallback;
  - `-0n` → `"0n"` inside a container; a **falsy** root `data` (`0n`, `-0n`, `""`) is omitted by the pre-existing
    truthiness check (no `data` field on base or on the fix), while a **truthy** root `10n` is encoded to `"10n"`;
  - a marker entry is a permanent gap in the dispatch audit for that spawn (`jev-check` exit 1) — intended.
- **Out of scope:** levels, rotation, `MAX_LOG_*`, the entry-shape contract, `safeLog`'s removal, teaching
  `jev-check`/`sprint-metrics` about the marker key, and the **17 other `JSON.stringify` sites in `src/`** — e.g.
  `session-manager.ts:532` agent persistence, already inside its own `try/catch` with a comment naming this fault class.
  Flagged, not fixed.

## 11. Acceptance criteria

1. Every hostile payload shape returns normally — cycle, `BigInt`, throwing `toJSON`, throwing getter, Proxy `get`,
   Proxy `ownKeys`, hostile `.message`, non-string `prefix`/`message` — cases 1–7, 10 and 11. **Falsifier:** any `not.toThrow()` red.
2. The file records a line for each hostile payload: `[Circular]`, `"10n"`, or **`{"[unserializable]":"<reason>"}`** —
   cases 1–7, byte-exact. **Falsifier:** a byte mismatch, a string marker, or a missing line.
3. A marker entry keeps `sprint-metrics.read_spawn_starts` working (`background: 1`, no exception) and makes
   `jev-check --log` fail closed (exit 1, `no task payload`) — both re-runnable from §8.8's commands.
   **Falsifier:** an exception in the former, or exit 0 in the latter.
4. The mirror is attempted **exactly once** for a hostile-but-serialisable payload — case 1. **Falsifier:** 0 (today) or 2.
5. Serialisable `data` is byte-identical to base and keeps key order — case 8 + the 9/9 probe. **Falsifier:** any diff.
6. A shared non-circular reference is preserved — case 9; M2 must be red.
7. The fallback is total for the **typed** API: `prefix`/`message` are `string`, and an untyped violation yields
   `"[unprintable prefix]"`/`"[unprintable message]"` on the fallback path — cases 7 and 11; M12 and M13 must be red. **Falsifier:** a
   `TypeError` escaping from the fallback.
8. No sticky degradation after a fallback-path fault — case 10; M7 must be red.
9. `message` is never swallowed by the fallback — cases 3–6, 10; M4 must be red.
10. No throw escapes the fallback itself, including an unguarded reason read — M6 **and** M10 must be red; the
    `ownKeys` fault must be pinned by its own case — M11 must be red.
11. `npx tsc --noEmit` exits 0.
12. `git diff` touches only `src/logging.ts`, `src/__tests__/logging.test.ts`, the `src/session-manager.ts` doc block —
    and changes none of `rotateIfNeeded`, `appendFileSync`, `resolveLogDir`, `LOG_LEVELS`, the filter, the file
    `catch {}`. **Falsifier:** a hunk in any of them.
13. The flow gate at the committed head exits 0 with `+190/+55 src (allowance 230) — within`.
14. The full-suite failing set differs from the clean-base capture by exactly the **9** names of §6 and by **0** from the
    fixed tree. **Falsifier:** any only-in-fixed name.

## 12. Open questions for the conductor

1. **Case 10's payload (recommend: throwing getter).** A cyclic payload leaves M7 alive (measured) because the replacer
   handles it before the `catch`; the replacer path's liveness is instead pinned by case 1's mirror assertion.
2. **Marker carries the reason (recommend: yes).** Cutting `faultReason` saves 8 source lines (→ +47, allowance 214) and
   loses the only evidence of *why*; the read is guarded (a hostile `.message` yields `"unknown fault"`, not a throw —
   case 6 + M10).
3. **§5.3 belongs in this PR (recommend: yes).** Net 0, keeps docs pinned to the contract, and is the same edit #543
   made in the other direction. The alternative is a false comment surviving a third cycle.
4. **Marker shape is now a two-consumer compromise (recommend: accept as specified).** The object keeps
   `sprint-metrics` working; `jev-check` still fails closed on it, which is the correct posture and unreachable from the
   tooling's own all-string spawn payloads. The alternative — teaching `jev-check` to read `data["[unserializable]"]` and
   exempt the entry — would convert an unauditable dispatch into a passing one, i.e. weaken the gate. If the conductor
   wants that instead, it is a separate issue against the audit tool, not this fix.
5. **No user-facing doc change (recommend: none).** `[Circular]`/`"10n"`/the marker are documented in code comments; no
   docs guard covers `logging.ts` behaviour.

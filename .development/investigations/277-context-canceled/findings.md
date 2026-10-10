# #277 Item 3 — source of `context canceled` in the full vitest run

**INVESTIGATION ONLY.** No tracked files modified. Worktree: `brl-subagent-wt-277` (branch `test/277-suite-noise`).

**Verdict: SOURCED — third-party tooling, not this repo's code/tests/config.**
The emitter is the **TypeScript 7 native compiler (`tsgo`)** binary
`@typescript/typescript-linux-x64/lib/tsc` (a **Go** executable). It is spawned by
`scripts/ts-ast.mjs` via `typescript/unstable/sync`'s `API`, with **stderr inherited**;
when `api.close()` SIGKILLs/SIGTERMs it under load, the Go runtime logs `context canceled`
to stderr, which the vitest worker forwards to the main process. Per the task's hard rule,
this is reported as external — no fix implemented.

---

## Environment findings (Rule 12 checklist)

| # | Check | Result |
|---|-------|--------|
| 1 | SDK/runtime version installed | Node **v24.14.1**; vitest **5.0.1** (`require('vitest/package.json').version`); vite **8.3.0**; jiti **2.7.0**. `typescript` devDep = **7.0.2** (the Go-native line). |
| 2 | Installed vs lockfile | Consistent: `package-lock.json` pins `node_modules/vitest` = **5.0.1** (line 3521), matching installed 5.0.1. `typescript` 7.0.2 installed, matches `package.json` (`^` range). |
| 3 | Extension synced | N/A for this investigation — the noise is emitted during `npx vitest run`, which does not load the pi extension. `node_modules` is a **symlink** → `brl-subagent-dev/node_modules` (worktree shares the dev checkout's deps; `scripts/ts-ast.mjs` resolves via that symlink). |
| 4 | Running extension current (/reload) | N/A — not a live-extension symptom. |
| 5 | Env vars | No `BRL_*` / `VITE_*` / `NODE_OPTIONS` overrides in the environment. `BRL_E2E_REAL_PI` unset (stub path). `NODE_OPTIONS` only set by me for tracer probes. |
| 6 | Audit trail | Not needed — the environment check (toolchain identity) already localised the emitter; see Root cause. |

Environment tooling note: **`strace` is NOT available** (WSL2, no binary on PATH),
so technique 3 (syscall trace) was skipped and fallback 4 (NODE_OPTIONS preload tracer)
was used instead — it succeeded.

---

## Root cause (verified)

The literal is Go's `context.Canceled.Error()` string. The only Go binary in the
pipeline is the TypeScript 7 native compiler.

### The emission chain (each link verified)

1. **Three test files import the AST adapter** (which drives the TS7 API):
   `src/__tests__/architecture-rules.test.ts`, `src/__tests__/runtime-vocabulary.test.ts`,
   `src/__tests__/terminal-status-consistency.test.ts` — all import `../../scripts/ts-ast.mjs`.
2. **`scripts/ts-ast.mjs:46`** imports `{ API } from "typescript/unstable/sync"` and
   `parseTexts()` (line ~107) constructs a **new `API` on every call**, closing it in `finally`.
   Verified stack from the tracer:
   ```
   at new SyncRpcChannel (typescript/dist/api/syncChannel.js:126)
   at new Client (typescript/dist/api/sync/client.js:36)
   at new API (typescript/dist/api/sync/api.js:40)
   at parseTexts (scripts/ts-ast.mjs:107)
   at moduleSourceFiles/scanTree (…architecture-rules.test.ts / terminal-status-consistency.test.ts)
   ```
3. **`typescript/dist/api/syncChannel.js` POSIX branch** spawns the native compiler with
   **stderr inherited**:
   ```js
   this.child = spawn(exe, args, { stdio: ["pipe", "pipe", "inherit"] });
   ```
   where `exe` = `.../@typescript/typescript-linux-x64/lib/tsc` and args =
   `["--api","--cwd",<cwd>,"--callbacks=readFile,fileExists"]`.
4. **`api.close()` → `SyncRpcChannel.close()` calls `this.child.kill()`** (syncChannel.js ~line 191).
5. The binary is a **statically-linked Go executable**:
   ```
   $ file .../@typescript/typescript-linux-x64/lib/tsc
   ELF 64-bit LSB executable, x86-64, statically linked, Go BuildID=AEt6… , stripped
   $ strings -a <tsc> | grep -c "context canceled"   →  1
   ```
   The same region also contains `signal received`, `context deadline exceeded` —
   the Go context/runtime strings.
6. When the SIGTERM races the Go server's shutdown under concurrent load, the runtime
   writes `context canceled\n` to its **inherited stderr** = the vitest worker's stderr pipe.
7. The worker's stderr socket is read by the vitest **main** process (tinypool) and
   re-emitted via `process.stderr.write` — visible in the tracer stack:
   ```
   at SyncWriteStream.process.stderr.write (trace.cjs)
   at Socket.ondata (node:internal/streams/readable:1012)
   at Pipe.onStreamRead (node:internal/stream_base_commons:189)
   ```

### Decisive evidence (preload tracer, full run)

`NODE_OPTIONS=--require .tmp/trace2.cjs npx vitest run`:
- `context canceled` on stderr: **11**
- `WORKER-STDERR` chunks seen by the main process: **11** — every one is exactly
  `data="context canceled\n"` (`grep WORKER-STDERR .tmp/tracer2.log`).
- The emitting workers (childPIDs of the main process) are **52909, 52915, 52918, 52942**.
- **Every one of those four workers is a tsgo spawner**:
  ```
  pid=52909 TSC-SPAWN count=28
  pid=52915 TSC-SPAWN count=41
  pid=52918 TSC-SPAWN count=22
  pid=52942 TSC-SPAWN count=1     (92 total)
  ```
  and every `TSC-SPAWN` stack traces back to one of the three ts-ast test files
  (architecture-rules / runtime-vocabulary / terminal-status-consistency).

### Direct reproduction (independent of vitest)

`scripts/ts-ast.mjs`-style open/close loop (`.tmp/repro-tsgo.mjs`):
- **Sequential** (1 process, 25 cycles): `context canceled` count = **0** (×3 runs).
- **Parallel** (8 processes × 25 cycles): total = **19**, emitted by **7 of 8** processes;
  every non-`repro:` stderr line is exactly `context canceled`.
This reproduces the full-suite signature (present only under load, count varies) outside
vitest entirely, pinning the emitter to the tsgo binary rather than any test harness code.

---

## Coverage (what each conclusion rests on)

| Command / query | Printed count / range | Reconciliation |
|---|---|---|
| `grep -c "context canceled"` on full-run capture (`.tmp/full-run-1.log`, merged) | **17** | Matches conductor's 14–17 range; suite green (61 files/1257 tests) |
| Split streams: stdout vs stderr | stdout **0**, stderr **12** | Emitter writes to **stderr** only |
| `grep -rn "context canceled" src scripts presets templates .pi .github` (tracked text) | **0** | Literal is absent from our code/config — rules out repo-side source string |
| `file` + `strings -a` on `@typescript/typescript-linux-x64/lib/tsc` | Go BuildID; `context canceled` ×**1** | The only Go binary in the pipeline; string present |
| `grep -rln "typescript/unstable" src scripts .github` | **2** files: `scripts/ts-ast.mjs`, `scripts/ts-ast.d.mts` | Single containment boundary for the TS7 API |
| `grep -rn "unstable/sync" src scripts .github` | **1** hit: `scripts/ts-ast.mjs:46` | Only spawner of the API client |
| `find src/__tests__ -name '*.test.ts' \| wc -l` | **61** | Full corpus = 61 test files |
| `grep -l ts-ast.mjs` importers | **3** test files | Only these spawn tsgo |
| Tracer: `grep -c TSC-SPAWN` / `WORKER-STDERR` | **92** / **11** | Each stderr chunk is `context canceled\n`; emitters ⊂ tsgo-spawning workers |
| Parallelism probes `--no-file-parallelism`, `--maxWorkers=2` | `context canceled` = **0** each | Concurrency/load dependence confirmed; it is a race, not deterministic |

**What these checks do NOT see:** `strings` proves the literal exists in the tsgo binary but
not which code path prints it (the direct repro covers that); the tracer cannot see inside a
child's own process, so attribution to tsgo rests on (a) stderr-inherit wiring + (b) the
direct repro. Global CLI/SDK bundles were already grepped by the conductor (absent) and were
not re-grepped here.

---

## Fix direction (external; NOT implemented — hard rule)

The emitter is **third-party**: Microsoft's TypeScript 7 native compiler
(`@typescript/typescript-linux-x64`, `typescript` 7.0.2). Both the `context canceled`
string and the stderr-inherit wiring (`stdio: ["pipe","pipe","inherit"]`) belong to
the `typescript` package, not this repo. Our only involvement is calling the documented
`API` from `scripts/ts-ast.mjs`.

If the team wants the suite output clean, the only lever *on our side* is to reduce the
number of tsgo process kills — e.g. reuse a single long-lived `API` across a test file's
parses instead of `new API()` per `parseTexts()` call (currently 92 spawns → 92 kills).
The message itself cannot be suppressed at the source without patching node_modules or
upstreaming to microsoft/TypeScript. This is out of scope for the investigation and was
deliberately not attempted.

---

## Dead ends / ruled out (so a re-run does not repeat them)

- **`strace` route (technique 3):** unavailable (WSL2, no binary). Recorded, moved to fallback 4.
- **Repo source string:** `grep` for the literal in `src/ scripts/ presets/ templates/ .pi/
  .github/` = 0 hits. Not our literal.
- **Running test files individually:** conductor already showed `git-real`, `session-manager`,
  `background-fan-out`, `e2e`, `e2e-subprocess` do **not** reproduce. Extended here: the 3
  ts-ast test files run **together** also produced **0** — confirming single/low-concurrency
  runs hide the race. Do not treat any individual file as the reproducer.
- **graphify** (`/home/azmeen/.local/bin/graphify`): a **Python** tool (uv shim), not invoked
  by vitest — eliminated as a Go-string candidate.
- **Clean sequential API open/close loop:** 0 occurrences → the message is not emitted on
  every `close()`; it needs the load race. A repro must be concurrent.
- **SIGTERM/SIGINT to an idle `tsc --api`:** 0 occurrences → the message needs the server to
  be mid-operation when killed, which is why only a fraction of the 92 kills print.

### Side observation (out of scope, not chased)
`npx vitest run --no-file-parallelism` and `--maxWorkers=2` both exited **1** with
**4 failures**, all in `src/__tests__/e2e-subprocess.test.ts` (chain/parallel/git/graph modes).
Default-parallelism full run is green. This is unrelated to `context canceled` and was not
investigated further.

---

## Raw artifacts (in `.tmp/`, untracked)
- `full-run-1.log` — merged full-suite capture with the 17-line block
- `split.stdout.log` / `split.stderr.log` — stream split
- `trace.cjs` / `tracer.log` — first tracer (captured the stderr stack)
- `trace2.cjs` / `tracer2.log` — second tracer (TSC-SPAWN stacks + WORKER-STDERR attribution)
- `repro-tsgo.mjs`, `repro-par-*.err` — direct repro (0 sequential / 19 parallel)
- `tsast-combined.log`, `nofp.log`, `mw2.log` — probe captures

---

## Conductor verification (2026-10-06, independent re-run)

- Binary: `file node_modules/@typescript/typescript-linux-x64/lib/tsc` → statically-linked Go ELF (Go BuildID); `strings -a … | grep -c "context canceled"` → **1**.
- Spawn wiring: `typescript/dist/api/syncChannel.js` spawns with `stdio: ["pipe","pipe","inherit"]`.
- Repro, sequential: `node repro-tsgo.mjs` (20 cycles) → **0** occurrences.
- Repro, parallel: 8 concurrent processes × 25 cycles → **10** occurrences across 6 of 8 processes; the only stderr lines were `context canceled`.
This reproduces the mechanism independently of the investigating agent's run.

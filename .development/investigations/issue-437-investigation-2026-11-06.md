# Issue #437 — completion wake after session replacement: investigation and decision proposal

Status: **investigation complete; no production change made.**
Risk class: **C1** (session lifecycle, background events, dedupe, retry). Tree: `dev` @ `1bbdab8`.
Inputs: current source, pi 1.5.0 installed package (`node_modules/@earendil-works/pi-coding-agent`, the
same 1.5.0 build the CLI runs), issue #437 body + both comments, and the untracked conductor draft
`.development/investigations/issue-437-fix-plan-2026-11-06.md` (read-only; its hypothesis was tested,
not assumed).

---

## 0. Recommendation in one paragraph

**Adopt Option C — per-generation ownership of terminal listeners** (a module-level activation token,
exact `eventBus.off` on `session_shutdown`, and a claim taken only after the live owner has resolved the
run). It is the smallest option that is correct under *every* teardown shape we could construct: clean
shutdown, a shutdown hook that never ran, and the factory-load → `session_start` window. Options A
(claim-last only) and B (unsubscribe only) each fix the observed `/new` case but fail a named lifecycle
mutant; do-nothing leaves the routine working day broken. Cost: ~35 lines in `src/index.ts`, no new
dependencies, no change to notification semantics. The cross-replacement delivery policy should be
declared **live-session-only** for this fix (drop + log where a listener exists + durable retrieval via `get_subagent_result`),
because the settle path cannot emit an event once its runtime is invalidated — a durable notice queue
would mostly never see an event and cannot honestly promise exactly-once.

---

## 1. Environment and version verification

| Item | Observed | Command / source |
|---|---|---|
| Checkout | `1bbdab8 docs(handoff): record #429 merge and qualify #437 diagnosis` | `git log --oneline -3`, `git status --short` (only the conductor draft untracked) |
| Package | `brl-subagent@2.7.0`, `pi.extensions = ["./src/index.ts"]` | `package.json` |
| pi (installed, in-repo) | `@earendil-works/pi-coding-agent@1.5.0` | `node -e "require('./node_modules/@earendil-works/pi-coding-agent/package.json').version"` → `1.5.0` |
| pi (global CLI, same version) | 1.5.0 under pnpm global | path inspection of `~/.local/share/pnpm/global/.../pi-coding-agent@1.5.0_...` |
| pi deps | `jiti@2.7.0` is a direct dependency of pi-coding-agent | `package.json` of the installed package |
| Test runner | `vitest 5.0.5`, node `v24.14.1` | repo `node_modules/.bin/vitest --version`, `node --version` |
| Baseline relevant suite | 3 files / 80 tests pass | `vitest run src/__tests__/terminal-notice-dedupe.test.ts src/__tests__/transport-auto-retry.test.ts src/__tests__/notify-completion.test.ts` |

Which pi does the extension load into? `package.json` declares the extension entry `./src/index.ts`; pi's
loader imports it through jiti with `moduleCache: false` and, in bundled builds, its embedded-module
variant (`dist/core/extensions/loader.js`, `loadExtensionModule`). Both variants are the same loader
module; the cache that matters is the loader's own `extensionCache` (see §3.1).

---

## 2. Recon and coverage

`bash .pi/skills/worktree/recon.sh deliverCompletionAlert --grep` @ `1bbdab8`:

- 1 graph caller (`src/index.ts`), impact 22 symbols across 21 files, **5 raw grep hits**.
- Raw hits: `src/index.ts:4134` (call), `:4208` (definition), `terminal-notice-dedupe.test.ts:396`
  (describe), `:16` (comment), `recovery-surface.test.ts:584` (comment). Coverage matches the task recon.

`bash .pi/skills/worktree/recon.sh sendCompletionNotification --grep`:

- 2 graph callers (`deliverCompletionAlert`, `src/index.ts`), impact 23 symbols across 22 files,
  **5 raw hits** (`notify-completion.ts:13` doc, `:301` definition, `index.ts:155` import, `:4232` call,
  `notify-completion.test.ts:7` comment). Coverage matches.

Graph gap acknowledged: the `eventBus` node selected a test mock; `src/event-bus.ts` was inspected
directly (module-level `listeners: Map<type, Set<listener>>`, insertion-order iteration, `off` exported
but **zero production call sites** — `grep -rn "eventBus.off" src` → no matches).

Blast-radius counts used in the options table:

- `eventBus.on` production sites: **1** (the terminal registration, `index.ts:4133`).
- `eventBus.emit` call sites: **15** across `src/` — **10 production** (all in `session-manager.ts`)
  + 5 in test files.
- Files referencing `event-bus`: **9** (4 production, 5 test files).
- `claimTerminalNotice` production callers: **3** — the wake (`index.ts:4210`), the poller crash notice
  (`index.ts:2022`), and `abandonInterruptedRun` (`recovery-surface.ts:369`).
- Test files that already touch claims: **4**.

---

## 3. Verified mechanism (what actually happens on `/new`)

### 3.1 The three actors

1. **The extension factory** (`src/index.ts` default export) registers three permanent terminal
   listeners at activation (`index.ts:4131-4135`) and captures `pi` and a per-instance `state`.
2. **The module-level event bus and claim set** (`src/event-bus.ts`, `src/notify-completion.ts:279`)
   hold the listener `Set` and `terminalClaims` `Set` at module scope.
3. **pi's loader** caches the extension *module factory* in a module-level `extensionCache` keyed by
   path. `clearExtensionCache()` runs only when a **previously loaded** `DefaultResourceLoader` reloads
   (`resource-loader.js:371-374`, `if (this.loaded) clearExtensionCache()`).

The host creates a **new** `DefaultResourceLoader` for every session runtime
(`agent-session-services.js:53-69`: new loader + `await resourceLoader.reload()`), and a new loader has
`loaded = false`, so it does **not** clear the cache. Every session replacement (`/new`, `/resume`,
`/fork`) therefore **re-invokes the factory against a fresh `ExtensionAPI`/runtime while reusing the
same module graph** — so the previous generation's listener closures are still in the same `Set`.
`/reload` is different: it reloads the *existing* loader (`loaded = true`) → `clearExtensionCache()` →
the module is re-evaluated → a fresh `Set` with only the new generation's listeners.

### 3.2 Loader probes (empirical, pi 1.5.0's real loader)

**Probe 1 — `loadExtensionsCached` twice, no cache clear** (`/tmp/brl437-probe/driver.mjs`):

```
load#1 {"gen":1,"listeners":["gen-1"]}
load#2 (new runtime, no clear) {"gen":2,"listeners":["gen-1","gen-2"]}
runtime#1 active after invalidate: false
load#3 after runtime#1 invalidated (no cache clear) {"gen":3,"listeners":["gen-1","gen-2","gen-3"]}
load#4 after clearExtensionCache (reload semantics) {"gen":1,"listeners":["gen-1"]}
```

Module-level state **survives** re-activation, the counter increments (factory re-invoked), and a cache
clear resets the module instance. Expected signature stated before running: shared state + growing
listener set + reset only on clear; observed exactly that.

**Probe 2 — two real `DefaultResourceLoader` instances + one same-instance reload**
(`/tmp/brl437-probe/driver3.mjs`, fidelity: this is the object `createAgentSessionServices` builds per
session):

```
loader#1 first reload (session 1)            {"generation":1,"listeners":["gen-1"]}
loader#2 first reload (session 2 = /new)     {"generation":2,"listeners":["gen-1","gen-2"]}
loader#1 second reload (/reload on loaded)   {"generation":1,"listeners":["gen-1"]}
```

**Probe 3 — the stale-handle contract on the real `ExtensionAPI`** (`driver2.mjs` / `driver4.mjs`):
after `runtime.invalidate("INVALIDATED-STALE")` (what `AgentSession.dispose()` does,
`agent-session.js:1035`), `sendMessage`, `appendEntry` and `getFlag` all throw `INVALIDATED-STALE`;
before invalidation they resolve to a real runtime. So both the captured `pi` **and** the captured
`ctx` are genuinely stale handles after replacement (ctx getters assert too, `runner.js:606-780`).

### 3.3 Red test against the current source

Harness: `/tmp/brl437/test/lifecycle-red.test.ts`, run with
`BRL437_SRC=/tmp/brl437/base/src vitest run --root /tmp/brl437`. It imports the **real** factory
(`src/index.ts`), the **real** `event-bus.ts` and `notify-completion.ts`, and drives two generations on
that one bus:

```
activate A -> session_start(ctxA) -> session_shutdown(ctxA) -> invalidate A (piA/ctxA throw)
activate B -> session_start(ctxB) -> emit subagent:completed for one run id
```

Expected signature before running: obsolete A consumes the terminal claim and the current B fails to
send. Observed (instrumented scratch copy, console probes removed from the final variant):

```
[437-probe] listener fired { id: ..., claimed: true,  hasCtx: true }     <- A (obsolete)
[437-probe] listener fired { id: ..., claimed: false, hasCtx: true }     <- B (live)
[437-probe] agent lookup { id: ..., found: true }
[437-probe] caught { error: 'This extension ctx is stale after session replacement or reload. ...' }
RED diagnostics: {"sendsA":0,"sendsB":0,"captured":0,"claimAfter":false,"staleWarnLogged":true}
```

**Exact failing boundary**: A claims synchronously at `index.ts:4210`, then `sessionCtx` is the stale
`ctxA` (it is *not* cleared on shutdown — `session_shutdown` clears `state`/counters but not
`sessionCtx`), `getAgent` succeeds, and `state.getRunEntries(ctx)` throws on the `ctx.sessionManager`
getter (`state.ts:401`). It is **not** `pi.sendMessage` that throws first on this path; the issue body's
"send throws" description is the second stale handle, not the observed first one. The catch at
`index.ts:4233-4236` downgrades it to `completion-push handler failed for <id>` — exactly the live log
line in #437. B then returns at the claim (`index.ts:4210`) with no log at all, which is why the loss is
invisible apart from A's warning.

This **confirms the conductor draft's hypothesis** (an obsolete listener claims first, then uses stale
handles); the two corrections are that the old instance does not receive the replacement
`session_start`, and that the ctx access — not `pi.sendMessage` — is the first throw on this path.

### 3.4 Why `/reload` heals — and why the workaround is only accidentally true

`/reload` (`AgentSession.reload()`, `agent-session.js:3018-3050`) emits `session_shutdown`, invalidates
the old runner, reloads the **same** resource loader (`loaded = true` → `clearExtensionCache()`), and
rebuilds the runtime. Probe 1/2 show the module graph is re-evaluated, so the old listener `Set` is
unreachable and only the fresh generation's listeners exist. That is why "`/reload` after `/new`" made
wakes work — it *discards* the accumulated listeners rather than repairing them. A `/new` after that
reload starts the accumulation again from the post-reload generation. (Controlled live evidence in the
issue comment is consistent: `/new` → lost, `/reload` → delivered.)

### 3.5 Correction to the issue's stated mechanism

The issue says `sessionCtx` is "REFRESHED at every session_start → valid" and that the activation-captured
`pi` is the stale reference. Both halves are wrong for pi 1.5.0:

- After a replacement, pi emits `session_shutdown` for the **old extension instance**, reloads/rebinds
  extensions, and then emits `session_start` to the **new instance** (`docs/extensions.md:512-513`,
  `529-530`, `601-603`). The old instance never receives the new `session_start`, so its `sessionCtx`
  stays at the old (now stale) context.
- The old `pi` *is* stale, but the first throw on the observed path is the ctx access; the send is never
  reached by the obsolete listener. A fix that only re-resolves the sender (`pi`) would still throw at
  `getRunEntries`.

This matters for the fix: the defect is **listener ownership**, not merely a captured API reference.

---

## 4. What the system actually guarantees today (settle during replacement)

Three emit families exist and they behave differently:

- **(a) Settle-path emits** — `finalizeRunEntry(...)` → `persistRunRecord(pi, entry)` → `pi.appendEntry`
  (`session-manager.ts:1453-1547`, `run-registry.ts:326-332`) runs **before** `eventBus.emit`
  (`session-manager.ts:2025/2059`). On a stale `pi`, `appendEntry` throws (`driver4`), the branch's emit
  never runs, and the outer `catch` calls `markTerminalBestEffort` which **does not emit**
  (`session-manager.ts:1835-1899`). Net: a run that straddles a replacement produces **no terminal
  event at all** — no wake, no retry, and no `completion-push handler failed` line (only
  `spawnBackgroundSession: completion handler failed`).
- **(b) `updateAgentStatus` emits** — persists the agent record to disk first (no `pi`), then emits
  (`session-manager.ts:993-1015`). This **can** emit after invalidation, e.g. a deadline abort or
  `stopAgent` landing in the replacement window. Such an event reaches the bus with no valid live
  generation yet (or an obsolete listener).
- **(c) Poller crash notices** — the per-spawn 2 s interval (`index.ts:2056+`) captures the spawning
  instance's `pi`/`ctx`; its crash branch calls `sendCrashNotice` = `claimTerminalNotice` **then**
  `pi.sendMessage` (`index.ts:2021-2033`). After replacement the interval is still alive, can claim an
  id, then throw on the stale `pi` inside `setInterval` (uncaught), suppressing the later settle wake.
  Code-inspected; not exercised end-to-end in this investigation.

Durability contracts that do survive a replacement:

| Artifact | Survives? | Evidence |
|---|---|---|
| Agent record `.pi/subagents/<id>.json` | Yes (disk, `persistAgent`) | `get_subagent_result` resolves by id through `getAgent` (`index.ts:3629+`); issue confirms the work survived |
| Durable in-flight registry `.pi/run-registry/<id>.json` | Cleared **before** the failing append (`clearInflightRun` then `appendEntry`) | `run-registry.ts:326-332`; so boot recovery will not see a straddling run as interrupted |
| Session run entry (transcript) | **No** for a straddling settle — the append throws | `persistRunRecord` last statement; driver4 |
| Boot recovery notice | Only for records still marked `interruptedAt`; a straddling settle never marks | `recovery-surface.ts`, `recovery-engine.ts` |
| Terminal claim (`terminalClaims`) | In-process only; per module graph (`/reload` resets, `/new` shares) | `notify-completion.ts:279` |

**Therefore**: today the system guarantees "the work is retrievable by id", **not** "the wake is
delivered". No exactly-once claim is defensible across a replacement, and none is made here.

---

## 5. Retry path (#365) audit

Eligibility, one-retry-only, source-notice suppression and fallback are already pinned by
`src/__tests__/transport-auto-retry.test.ts` (predicate matrix + handler: one spawn, no source notice,
one toast, attempt-2 does not chain). Those pass on the baseline (part of the 80-test run).

What was **not** covered — behavior across a replacement — was tested in scratch
(`/tmp/brl437/test/retry-across-generations.test.ts`, mocked `spawnBackgroundSession`/`getAgent`,
real factory/bus, two generations):

```
base  clean replacement: spawns 0, captured 0   -> retry dies after /new
base  missed shutdown:   spawns 0, captured 0
candC clean replacement: spawns 1               -> live generation retries once
candC missed shutdown:   spawns 1
```

Reason: the retry branch (`index.ts:4223`) sits **after** `state.getRunEntries(ctx)`, which is the exact
stale throw site, and the live listener never wins the claim. So #365's "no conductor re-dispatch"
recovery contract is **also broken after `/new`** — the issue's suspicion is confirmed, and it is the
same root cause, not a second bug.

Distinguish evidence from hypothesis:

- **Proven**: after a replacement, a transport-failed background run produces zero retry spawns on
  current source and one on the recommended candidate.
- **Proven**: the retry uses the listener's captured `pi`/`ctx` (`scheduleTransportRetry` →
  `spawnBackgroundRun(pi, ctx, ...)`, `index.ts:4157-4205`), so it must run on the live generation.
- **Not proven**: retry behavior when the replacement happens *during* the retry's awaits (a run settles,
  the retry spawn is in flight, `/new` lands). The candidate re-checks ownership after the await and
  drops with a warn; that path is code-only, not lifecycle-tested (hard to interleave deterministically
  without a hook).

---

## 6. Options

| # | Option | Mechanism | Blast radius | Cost | Risk if wrong |
|---|---|---|---|---|---|
| **0** | **Do nothing** | Keep `/reload`-after-`/new` (or a restart) as the workaround | none | 0 | Every routine `/new` loses wakes and auto-retries; users are forced to poll, which the product contract forbids |
| **A** | **Claim-last only** | Move `claimTerminalNotice` after ctx/agent/run resolution; log instead of silently returning when `sessionCtx` is missing | `src/index.ts` ~8 lines | S | 3 listeners + a whole factory closure retained per generation (measured: 30 after 10 generations); one stale-warn per terminal event forever; two live generations can both deliver during the shutdown overlap |
| **B** | **Listener lifecycle** | A + remember the three listener functions and `eventBus.off` exactly those in `session_shutdown` (idempotent) | `src/index.ts` ~20 lines + tests | M | Depends on the shutdown hook always running; a missed/throwing teardown leaves the obsolete listener and the bug returns (scratch mutant fails) |
| **C** | **Per-generation ownership** *(recommended)* | B + module-level `activationSeq`/`activeGeneration`; each listener is gated synchronously on `activeGeneration === myGeneration` before any claim; ownership is set in `session_start` and released before unsubscribe in `session_shutdown`; claim-last; warn on no live session | `src/index.ts` ~35 lines + tests; no new deps | M | Low. If pi's loader semantics change, the gate becomes inert but the unsubscribe still satisfies the documented cleanup contract |
| **D** | **Host event bus** | Replace the module bus with `pi.events.on/emit` (pi tracks those subscriptions per runtime and unsubscribes them in `runtime.invalidate`, `loader.js:145-166`); emit sites take `pi` (already in scope at settle) | `event-bus.ts` retired or re-exported; **10** production emit sites, **9** files, 5 test files | L | Host bus is documented for inter-extension events; semantics for high-frequency internal events are unproven; does not fix straddling settles (no event is emitted at all); large diff for the same wake outcome |
| **E** | **Durable handoff queue** | C + persist a pending terminal notice when no generation is live, replay it at the next `session_start`, dedupe by run id | new module + state + boot-path integration + tests | XL | Promises cross-gap delivery without a proven exactly-once mechanism; mostly dead code today because family (a) settles cannot emit after invalidation (§4) |

### 6.1 Why C over A

A is tempting: it is a reorder and it **passes every lifecycle and retry test in the scratch matrix**
(§9). It is rejected because it leaves two defects unfixed:

- **Retention**: every replacement permanently adds 3 listeners; each closure captures the generation's
  `pi`, `sessionCtx`, `state` and the whole factory scope. Measured with a scratch-only counter export:
  **30 listeners after 10 clean generations** vs **0** for C.
- **Ownership during overlap**: between `session_shutdown` and `dispose()` the old ctx/pi are still
  valid (the shutdown handler awaits `reapActiveChildren`). Two live listeners can both resolve and send
  for the same id if the claim is moved late — A has no gate, only the claim, and the claim is now
  taken after the await. C's generation token makes the obsolete listener a no-op for that whole window.

### 6.2 Why C over B

B fixes the observed `/new` case and stops the leak, but it is only as reliable as the teardown hook.
The scratch mutant "missed shutdown" (factory re-activated without `session_shutdown`, handles stale)
makes B fail exactly like the baseline. C's gate makes that shape harmless, which also covers a shutdown
handler that throws before the unsubscribe.

### 6.3 Why not D (host bus) in this fix

D is architecturally attractive — the host already removes per-runtime subscriptions on invalidation,
which is precisely the lifecycle we need — but it moves the eventing model, touches 10 production emit sites, and
still cannot deliver a straddling settle. It should be an ADR/structural follow-up only if the module
bus is retired for other reasons.

### 6.4 Why not E (handoff) now

A queue would be the right answer to "the wake must survive the gap", but family (a) settles cannot emit
after invalidation (`appendEntry` throws first), so the queue would only ever see family (b) events. The
honest product statement today is "the work survives; the wake is best-effort per live session". If the
maintainer wants gap delivery, the durability defect in §4 must be fixed first (persist the terminal
run/agent outcome outside the stale `pi`), then a queue can be designed against a real event.

---

## 7. Recommended implementation sketch (C)

All changes are in `src/index.ts`; no new dependencies, no change to message content or delivery matrix.

```ts
// module scope, above the factory
let activationSeq = 0;
let activeGeneration = 0;          // 0 = no live generation

export default function (pi: ExtensionAPI) {
  const generation = ++activationSeq;
  const log = createLogger("brl-subagent");
  let state = createSessionState(log);
  let sessionCtx: ExtensionContext | undefined;
  // ... existing state ...

  pi.on("session_start", async (_event, ctx) => {
    activeGeneration = generation;         // claim ownership first
    sessionCtx = ctx;                      // then the handle
    // ... existing body unchanged ...
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    // ... existing reap + cleanup, unchanged ...
    try {
      // existing body
    } finally {
      if (activeGeneration === generation) activeGeneration = 0;   // release BEFORE off
      unsubscribeTerminalListeners();                              // idempotent
    }
  });

  const TERMINAL_TYPES = ["subagent:completed", "subagent:failed", "subagent:stopped"] as const;
  const terminalListeners: Array<{ type: typeof TERMINAL_TYPES[number]; listener: (e: SubagentEvent) => void }> = [];
  for (const type of TERMINAL_TYPES) {
    const listener = (event: SubagentEvent) => {
      if (activeGeneration !== generation) {
        // Obsolete generations are expected and stay silent — including the
        // overlap where the OLD generation still owns the session. Only a
        // loaded-but-not-started NEWEST generation has no owner at all, and
        // that loss must be visible because nothing else can report it.
        if (activeGeneration === 0 && generation === activationSeq) {
          log.warn("completion wake skipped — session not started yet", { agentId: event.agentId, event: event.type });
        }
        return;                                      // never claim, never send
      }
      void deliverCompletionAlert(event);
    };
    terminalListeners.push({ type, listener });
    eventBus.on(type, listener);
  }
  function unsubscribeTerminalListeners(): void {
    for (const { type, listener } of terminalListeners) eventBus.off(type, listener);
    terminalListeners.length = 0;
  }

  async function deliverCompletionAlert(event: SubagentEvent): Promise<void> {
    const id = event.agentId;
    const ctx = sessionCtx;
    if (!ctx) {
      log.warn("completion wake skipped — no live session context", { agentId: id, event: event.type });
      return;                                        // do NOT consume the claim
    }
    try {
      const { getAgent } = await import("./session-manager");
      const agent = getAgent(id);
      if (!agent) return;                            // pruned/foreign id: no claim
      if (activeGeneration !== generation) return;   // re-check after the await
      const knob = state.config.completionNotify ?? "all";
      const run = resolveRunEntry(state.getRunEntries(ctx), id);
      if (!claimTerminalNotice(id)) return;          // CLAIM-AFTER-VALIDATION
      if (event.type === "subagent:failed" && run && isTransportRetryable(run)) {
        const retried = await scheduleTransportRetry(ctx, run);   // claim held: no double retry
        if (activeGeneration !== generation) {
          log.warn("completion wake dropped — session replaced during transport retry", { agentId: id, retried });
          return;                                    // never send with stale handles
        }
        if (retried) return;
      }
      const message = buildCompletionMessage(agent, run);
      const delivery = resolveDelivery(message.details.status, knob);
      sendCompletionNotification(pi, message, delivery);
    } catch (err) {
      log.warn(`completion-push handler failed for ${id}`, { error: (err as Error).message });
    }
  }
}
```

Ordering rules the implementer must preserve (each is pinned by a test in §8):

1. **Gate before claim**, synchronously, in the listener wrapper — never after an await.
2. **Release ownership before unsubscribe** in shutdown, so an invocation queued behind the handler
   drops at the gate rather than claiming.
3. **Claim after ctx/agent/run resolution, before the retry spawn and before the send** — a missing
   context or a pruned agent must not consume the single notice.
4. **Unsubscribe exactly this generation's functions** — never `listeners.clear()`, never a bus reset.
5. **Re-check ownership after the retry await** and drop with a warn rather than sending with stale
   handles.
6. Idempotent teardown: double `off` and double shutdown are safe; a later generation's listeners are
   untouched.

Residual diagnostic gap (state it in the PR): once the last generation unsubscribes, a terminal event
emitted in the shutdown→next-`session_start` gap has **no listener at all**, so it is silent even though
the claim stays free. That is better than today's false claim, but if "a lost wake must never be
traceless" is a hard requirement, add one module-level **sentinel** subscriber that logs (never claims)
when `activeGeneration === 0`; it costs ~8 lines and does not participate in delivery. Decide under Q1.

Do **not** in this fix: change `claimTerminalNotice`'s crash-notice users, change delivery modes, or
touch the poller (`index.ts:2021-2033`, `2056+`) — that is a separate stale-handle path (see Q3).

---

## 8. Tests the implementer must add, and named mutations

New file `src/__tests__/terminal-listener-lifecycle.test.ts` (pattern: the scratch harness in §9/§13;
`vi.resetModules()` per test, because the defect under test *is* permanent module listeners — the
existing "one instance for the whole file" comments in `terminal-notice-dedupe.test.ts:36` and
`transport-auto-retry.test.ts:19` must be updated to say why the isolation changed).

Required cases (each observes **messages/retry calls**, not just listener counts):

1. **Two generations, clean shutdown**: A session_start → A session_shutdown (A handles invalidated) →
   B session_start → emit completed/failed/stopped. Exactly one `subagent-completion` from B; A logs
   nothing; the run settles once.
2. **Missed shutdown**: same but A's `session_shutdown` is never invoked. Exactly one wake from B
   (this is the case Option B fails).
3. **Startup window**: B factory-activated but `session_start` not yet emitted; emit. No message; the
   terminal claim is **still free** (assert via a subsequent send/claim), and a warn is logged.
4. **No live session**: A shut down, no B; emit. No message; claim still free. With C no listener
   remains, so nothing is logged — that is the residual diagnostic gap above; assert the claim survives
   (and, if the sentinel is adopted, assert its warn).
5. **Idempotent teardown**: double shutdown for A after B is live; B's wake still delivers; unrelated
   listeners registered by another consumer still receive the event.
6. **Retry across generations**: transport-class failure; exactly one `spawnBackgroundSession` call
   from the live generation, source notice suppressed, toast on the live ctx, attempt 2 recorded.
7. **Retry during replacement**: (hook-based) replacement lands during the retry await → no stale send,
   one warn.

Named mutations (each must make exactly the indicated test fail; verified in scratch):

| Mutation | Expected failing test | Scratch evidence |
|---|---|---|
| Delete the `eventBus.off` block | Two generations (1) | base = candidate minus all lifecycle code → 5/6 fail |
| Delete the `activeGeneration !== generation` gate | Missed shutdown (2) | `candBmut` (unsubscribe + claim-last, no gate) → case 2 fails |
| Move `claimTerminalNotice` back to the first line | Startup window (3) | `candB`/`base` → case 3 fails (`claimSurvived:false`) |
| Remove the claim entirely | Two generations (1) / duplicate send test | out of scope but should be caught by the existing dedupe suite |

Acceptance gates (from the draft, kept): full `vitest run` and `npm run typecheck` in the cockpit;
existing 80 relevant tests stay green; C1 adversarial review. On the copied tree, 31/32 of the relevant
suite passed for every variant including base — the one failure
(`transport auto-retry — a preamble carrying preset and capability keywords…`) is a fixture-path
artifact of the copy (missing `presets/`/`templates/` at the copied root) and fails identically on
unpatched base, so it is not a regression signal; the real gate is the cockpit run.

Real-host acceptance (maintainer-triggered, not automatable here): repeat the controlled sequence
(startup → `/new` → settle → `/reload` → settle) and verify the wake text, run id and log at each
stage. Add one **straddling** run (dispatch, immediately `/new` while it runs) and record what happens:
our model predicts no terminal event (the settle write throws at `pi.appendEntry`) and therefore no wake
and no `completion-push` warn — confirming §4 rather than silently assuming a delivery.

---

## 9. Scratch validation matrix (what was actually run)

Six lifecycle cases in `/tmp/brl437/test/lifecycle-red.test.ts` (control + five above, minus the retry
ones which live in a second file):

| Variant | lifecycle (6 tests) | retry across gens (2) | listeners after 10 clean gens |
|---|---|---|---|
| `base` (current source) | 5 fail / 1 pass | 2 fail (0 spawns) | **30** |
| `candD` = claim-last only (A) | **6 pass** | **2 pass** | 30 (unchanged) |
| `candB` = unsubscribe, claim-first | 2 fail (missed shutdown, startup window) | 1 fail (missed shutdown) | 0 |
| `candBmut` = unsubscribe + claim-last (B) | 5 pass (**missed shutdown fails**) | 1 fail (missed shutdown) | 0 |
| `candC` = gate + unsubscribe + claim-last (C) | **6 pass** | **2 pass** | 0 |
| `candC3` = C + not-started warn (recommended) | **6 pass** | **2 pass** | 0 |
| `candCmut` = C with claim moved first | 6 pass (gate masks the ordering defect) | — | — |

Reading: A fixes delivery but not retention; B fixes delivery and retention but not a missed teardown;
C fixes all three. The claim-ordering change is independently pinned by the startup-window case on the
B-shaped variant (where no gate exists to mask it).

---

## 10. Falsifiers (what would change the recommendation)

1. **Loader identity**: if a real pi 1.5.0 `/new` were shown to re-evaluate the extension module (fresh
   `Set`), the obsolete-listener mechanism would be wrong. Contradicted by probes 1–2 and by the
   doc statement that extensions are reloaded and a new instance receives `session_start`; the red test
   reproduces the live log line on current source.
2. **Ordering**: if the live generation won the claim before the obsolete one, the red test would pass
   on base. It fails with `claimed:true` then `claimed:false` — obsolete first.
3. **Boundary**: if the first throw were `pi.sendMessage`, the stale-ctx reordering would be
   insufficient. The instrumented run shows the throw at `ctx.sessionManager` before the send; both are
   stale, but the fix must not assume either order.
4. **Teardown guarantee**: if `session_shutdown` were proven to always run to completion before any new
   generation can activate, Option B would be sufficient and the gate optional. The missed-shutdown
   mutant is the discriminator; the maintainer should decide whether that shape is in-contract.
5. **Policy**: if the product wants wakes to survive a session gap, Option E becomes necessary — but
   only after the straddling-settle durability defect is fixed, otherwise the queue has no events.

---

## 11. Open decisions (maintainer)

- **Q1 — delivery policy for "no live session".** Recommended: drop + rely on `get_subagent_result` /
  history and never claim; log where a listener is still present (the newest-generation-not-started
  case). Add the module-level **sentinel** if "never traceless" is a hard requirement, since after the
  last unsubscribe a gap event has no listener. Alternative: durable queue + replay (Option E). This is
  a product contract, not a code detail.
- **Q2 — straddling settle durability.** A run that settles after its runtime is invalidated writes no
  session run entry (the append throws) and its registry entry is already cleared, so boot recovery
  cannot surface it; only the agent record survives. Fix separately? Recommended: yes, separate issue —
  it is a persistence defect, not the wake bug.
- **Q3 — poller crash notices.** The per-spawn interval's `claimTerminalNotice` + `pi.sendMessage` is a
  second stale-handle path (§4c). Same PR or follow-up? Recommended: follow-up with its own test; it
  needs an ownership/handoff decision for a run whose poller outlives its generation.
- **Q4 — synchronous handler.** Hoisting `getAgent` to a static import would remove the handler's only
  await before the send and make claim→send atomic. Needs a cycle check (`index.ts` currently uses
  dynamic imports for `session-manager`); not required for correctness.
- **Q5 — host bus.** Adopt `pi.events` as the structural bus (host-managed unsubscription) in an ADR?
  Recommended: no, not for this fix.
- **Q6 — wake for a run in the previous transcript.** Today the builder falls back to the agent record
  (no cost/duration/category). Confirm that a wake for a run the new session cannot see is acceptable
  (it is delivered by id, and `get_subagent_result` resolves it).

---

## 12. Evidence log (commands, outputs, coverage, limits)

All scratch work is under `/tmp`; the cockpit was read-only except the assigned output file.

| Claim | Probe / read | Observed (coverage) |
|---|---|---|
| Recon counts | `recon.sh deliverCompletionAlert --grep`, `recon.sh sendCompletionNotification --grep` | 1 caller / 22 symbols / 21 files / 5 hits; 2 callers / 23 symbols / 22 files / 5 hits |
| No production unsubscribe | `grep -rn "eventBus.off" src` | 0 matches (coverage: all `src/*.ts`) |
| Module state survives re-activation | `/tmp/brl437-probe/driver.mjs` (`loadExtensionsCached` ×2, invalidate, clear) | gen 1→2→3 with a growing listener set; clear → gen 1, fresh set |
| Host per-session loading | `/tmp/brl437-probe/driver3.mjs` (two `DefaultResourceLoader`s + one reload) | session 2 shares the module graph; reload re-evaluates |
| Stale API contract | `driver2.mjs`, `driver4.mjs` (real `ExtensionAPI` after `runtime.invalidate`) | `sendMessage`, `appendEntry`, `getFlag` all throw the stale message |
| Red: obsolete listener claims first | `/tmp/brl437/test/lifecycle-red.test.ts` on `base` | `claims: true` then `false`; sends 0/0; warn logged; claim consumed |
| Exact boundary | instrumented copy (`/tmp/brl437/instrumented`) | throws at `ctx.sessionManager` in `state.getRunEntries` before the send |
| Retry dies after `/new` | `/tmp/brl437/test/retry-across-generations.test.ts` | base 0 spawns; candC 1 spawn |
| Listener retention | `/tmp/brl437/test/listener-count.test.ts` + scratch `__listenerCount()` | base 30 after 10 generations; candC 0 |
| Claim-order mutation | `candB`/`base` vs `candBmut` | startup-window claim survives only with claim-last |
| Existing behavior preserved (copied tree) | `vitest --root /tmp/brl437/<variant>` on dedupe + retry suites | 31/32 for base and every variant (same fixture-path failure) |
| Cockpit baseline | `vitest run` on dedupe/retry/notify | 80/80 pass |

Limits / negative results:

- **Not run**: a live interactive pi session driving `/new`/`/reload` end-to-end with the patched
  extension (the task forbids modifying the checkout; the issue's controlled observations remain the
  live evidence). The loader probes and the real-factory red test substitute for the loader half.
- **Not proven**: the exact cause of the earlier post-`/reload` missing wake with no warn. §4a is a
  code-supported candidate (a straddling settle throws at `appendEntry` before emitting, and
  `markTerminalBestEffort` never emits), but the run's dispatch/settle timing is not in the issue
  evidence. Do not adopt it as established.
- **Not exercised end-to-end**: the poller crash-notice stale path and the retry-during-replacement
  race; both are code-inspected with proposed tests.
- **Copy artifact**: the copied-tree suite's preamble test fails on base too (missing `presets/`,
  `templates/` at the copy root); it is not evidence against any variant.
- The initial scratch run misdiagnosed the control as broken because the handler's
  `await import("./session-manager")` resolves on a later macrotask and the test teardown deleted the
  agent store first; fixed by waiting a real tick. Recorded here because it is a genuine property of
  the handler: the claim is synchronous, the delivery is not.

---

## 13. Scratch inventory (reproducible, no repo writes)

```
/tmp/brl437-probe/driver.mjs   loader cache identity (loadExtensionsCached)
/tmp/brl437-probe/driver2.mjs  real ExtensionAPI stale contract (sendMessage)
/tmp/brl437-probe/driver3.mjs  two DefaultResourceLoaders + same-loader reload
/tmp/brl437-probe/driver4.mjs  stale appendEntry/sendMessage/getFlag
/tmp/brl437/base/src           pristine copy of the checkout's src (baseline)
/tmp/brl437/candD/src          claim-last only (Option A)
/tmp/brl437/candB/src          unsubscribe, claim-first
/tmp/brl437/candBmut/src       unsubscribe + claim-last (Option B)
/tmp/brl437/candC/src          generation gate + unsubscribe + claim-last (Option C)
/tmp/brl437/candC3/src         C + "newest generation, session not started" warn (recommended shape)
/tmp/brl437/test/lifecycle-red.test.ts        six lifecycle cases
/tmp/brl437/test/retry-across-generations.test.ts
/tmp/brl437/test/listener-count.test.ts
```

Run them with the cockpit's vitest, e.g.:

```
BRL437_SRC=/tmp/brl437/base/src ./node_modules/.bin/vitest run --root /tmp/brl437 test/lifecycle-red.test.ts
```

No repository file was modified; `git status --short` after all work shows only the conductor's
untracked draft and this report.

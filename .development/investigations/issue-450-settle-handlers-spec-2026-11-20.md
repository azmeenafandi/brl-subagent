# #450 — attach the background settle handlers before the prompt (shape (b))

**Issue:** #450 — hardening. Recorded priority **low** (2026-11-20: bounded consequence, zero observed incidence) ·
classifier risk **C1** · `fix: mechanical` · worktree **y** · review: **C2 focused**.
**Cycle:** `settle-handlers` (open 2026-11-20) — **U1**.
**Spec:** 2026-11-20, against `dev @ 10cf885` (`src/session-manager.ts` 2,723 lines;
`src/__tests__/session-manager.test.ts` 3,456 lines).

## Context (verified 2026-11-20)

Recon holds: `git log --since=2026-11-14 -- src/session-manager.ts src/background-pipeline.ts
src/__tests__/session-manager.test.ts src/__tests__/background-session-persistence.test.ts` is **empty**, and
every anchor matches:

| Anchor | Line | What it is |
|---|---|---|
| `armDeadline(...)` | `:2462` | the one deadline owner (#453), armed **before** the prompt |
| `run.acceptedAt = new Date().toISOString()` | `:2472` | the durable acceptance marker (#447) |
| `persistRunRecord(pi, run, "background")` | `:2474` | the acceptance write (throw → `failPreStart` → rethrow) |
| `runPromise = session.prompt(wrapTask(params.task))` | `:2490` | the one call whose return must be monitored |
| `runPromise.then(...)` | `:2501` | the settle handlers, attached **after** the call returns |
| `}).catch((err: Error) => {` | `:2651` | the rejection settle |

`failPreStart` (`:1942`) already: clears the deadline (`:1943`), tears the work branch down, finalizes the run
entry `failed`, and retires the registry entry. `cleanupWorkBranch` is once-per-run (`gitCleanupDone`, `:1841`).

## The defect and why shape (b)

The window is two statements wide: `session.prompt()` returns, then `.then(...)` attaches. **Nothing can run in
between** — no `await`, no callback — so the only way a successful settle is lost is a *throwing statement added
between them by a future edit*. The pre-armed deadline bounds and classifies that state, so the worst case is a
lost **successful** settle: the outcome is replaced by a timeout snapshot, `cleanupWorkBranch` never runs, and the
work-branch lock + session dir are held until process exit.

That is why the issue is C1/low: a **regression risk on a hot region**, not an active bug (591/591 background
spawns settled, 0 background timeouts). This spec closes the window structurally and pins the ordering so the
next edit to the region goes red instead of silently reopening it.

**Shape (b)** from the #439 investigation §5.2, and only shape (b):

- create a deferred, attach the settle handlers to **its** promise, *then* invoke `session.prompt()` and route
  the returned promise's settlement into the deferred.
- Not shape (a) (`Promise.resolve().then(() => session.prompt(...))`): it empties the window but changes the spawn
  queue's interleaving (`resolveNext()` would run before the prompt), loses the synchronous acceptance, and turns
  a pre-start rejection into an async terminal event.

## Design

### D1 — Deferred + attachment, after acceptance, before the prompt

Create the deferred **after** the acceptance write succeeds (an acceptance throw must not leave a pending
deferred) and attach the handlers **before** `session.prompt()`:

```ts
// #450: the settle handlers attach to a DEFERRED before prompt() is invoked, so
// no statement between the call and the settle can lose a successful settle.
// The pre-armed deadline classifies the window it replaces; this closes it.
const PRE_START_SETTLED = Symbol("preStartSettled");
let resolveSettled!: () => void;
let rejectSettled!: (err: unknown) => void;
const settled = new Promise<void>((res, rej) => { resolveSettled = res; rejectSettled = rej; });

settled
  .then(() => { /* — the existing :2501 body, unchanged — */ })
  .catch((err: unknown) => {
    if (err === PRE_START_SETTLED) return; // D2: already settled pre-start
    /* — the existing :2651 body, unchanged except `err as Error` — */
  });
```

The `.then(...).catch(...)` topology is preserved exactly: a throw inside the success body is still contained by
its own try/catch (`markTerminalBestEffort('completed')`), and a genuine prompt rejection still reaches the
catch body. **No statement of either body changes** except the `err` narrowing after the sentinel guard.

### D2 — The pre-start throw path releases the deferred with a sentinel

```ts
let runPromise: Promise<unknown>;
try {
  runPromise = session.prompt(wrapTask(params.task));
  // #450: the routing attach sits in the SAME try as the call, so a prompt that
  // returns a non-thenable cannot escape the pre-start catch either.
  void runPromise.then(() => resolveSettled(), (err) => rejectSettled(err));
} catch (err) {
  failPreStart(sanitizeErrorMessage((err as Error).message, effectiveCwd));
  // #450: release the deferred's handlers. `failPreStart` has ALREADY settled
  // this run (deadline cleared, branch torn down, entry finalized, registry
  // retired), so the failure body must not settle it a second time — the
  // sentinel makes it a no-op instead of a duplicate terminal write.
  rejectSettled(PRE_START_SETTLED);
  throw err;
}
```

The sentinel is a per-spawn `Symbol`, so nothing outside this invocation can construct it. Rejecting (not
abandoning) the deferred matters even though the body returns early: a pending promise retains its handler
closures for the life of the process.

### D3 — Deadline interaction

- The deadline stays armed at `:2462`, before the acceptance write and before the deferred — unchanged.
- `failPreStart` already clears it (`:1943`), so the sentinel path needs **no new clearTimeout**. The issue's
  cost 2 (the pre-start catch must clear the timer or the deadline fires against a failed run) is **already
  satisfied**; the spec records that rather than re-implementing it.
- The settle bodies keep their own `clearTimeout` (`:2502`, `:2652`) for the genuine prompt outcomes.

### D4 — The extra microtask hop

Today: prompt settles → the handler body runs in the same microtask turn as the caller's `await` resumption.
Shape (b): prompt settles → `resolve/reject` → the handler body, one hop later. Measured harmless in the #439
investigation §5.2 (no test observes it). The suite may still contain timing-sensitive tests; the full suite is
the evidence, and any test that needs one extra flush gets it — a test change, never a production workaround
(e.g. no synchronous resolve trick).

### D5 — No behaviour change for a successful run

Same terminal writes in the same order, same `agent.status` at return (`running`), same queue release, same
events, same transcript calls. The only new object is the deferred.

## Acceptance criteria

1. `session.prompt()` is invoked **after** the settle handlers are attached — `settled.then(...)` appears above
   the prompt call in source order, and no statement that can throw sits between the acceptance write and the
   attachment.
2. A synchronous `prompt()` throw still: finalizes the run entry `failed` **exactly once**, rejects the spawn
   with the original error, clears the deadline, and leaves no pending deferred (released with the sentinel).
3. An async `prompt()` rejection still settles once through the catch body (message, `stopReason: "error"`,
   `agent.status === "failed"`).
4. The successful path is unchanged: `done` entry, branch capture, transcript `completed`, one terminal write.
5. The spawn queue's release semantics are unchanged (`resolveNext()` on every exit path).
6. The ordering invariant is **pinned by a test**, not by line numbers.
7. Full suite green; no other source file changes.

## Tests

### New (1)

- **Ordering ratchet** — `src/__tests__/session-manager.test.ts`, source scan (precedent: the
  `sections builder` ratchet at `:309` reads `src/session-manager.ts`):
  slice `spawnBackgroundSession`; assert `run.acceptedAt =` < the deferred attachment marker < `session.prompt(`
  by `indexOf`; assert the slice between the acceptance write and the attachment contains no `await`; assert the
  `session.prompt(` call and the `runPromise.then(` routing are inside the **same** `try` (no `} catch` between
  them). The test names the invariant in its title and its failure message, so a future edit that reorders the
  region is told why it went red.

### Not added, and why

- **Async-rejection coverage already exists** — "finalizes the run entry to failed when the session rejects"
  (`:2552`) pins the message, the status and `SETTLED_RUN_WRITES`. It is the behavioural evidence that the
  deferred routing is equivalent, and it must stay green untouched.
- The F1 test (`:2657`) is **kept**, not replaced (decision recorded on the issue 2026-11-20): the sync catch is
  defence-in-depth and #453's pre-prompt arming relies on the same path. Its `SETTLED_RUN_WRITES` assertion is
  also the guard against a double settle on the sentinel path.

### Must stay green (current lines)

| File | Test |
|---|---|
| `session-manager.test.ts:982` | "arms the deadline before it returns, so a CALLER throw cannot unbounded the run (#453)" |
| `session-manager.test.ts:1007` | "clears a deadline armed before prompt() when the spawn throws synchronously (#448)" |
| `session-manager.test.ts:1649` | "review C: a throwing settle still tears the work branch down (catch-all)" |
| `session-manager.test.ts:2390` | "releases the ref via markTerminalBestEffort when a settle handler throws" |
| `session-manager.test.ts:2483` | "persists a session run entry with the agent id at spawn" |
| `session-manager.test.ts:2552` | "finalizes the run entry to failed when the session rejects" |
| `session-manager.test.ts:2657` | "finalizes the run entry to failed when prompt() throws synchronously (review F1)" |
| `background-session-persistence.test.ts:198` | "normalizes an instantly-firing timeout to the 30m default, not to ~1ms" |
| `background-session-persistence.test.ts:268` | "success: removes the per-run dir when the prompt completes" |
| `background-session-persistence.test.ts:286` | "timeout/abort: removes the dir when the deadline aborts the run" |
| `background-session-persistence.test.ts:752` | "markTerminalBestEffort: prunes the dir when a settle step throws" |

Plus the spawn-queue interleaving / immediate-`running` pins in the same file.

## Risks

- **The microtask hop (D4)** could turn a timing-sensitive test red. Expected handling: one extra flush in the
  test, stated in the PR body. If a *production* path depends on same-turn settlement, that is a finding — stop
  and record it, do not work around it.
- **`err` narrowing** in the catch body: `(err: unknown)` + `const promptError = err as Error` after the guard;
  every `err.message` use in the body moves to `promptError.message`. Mechanical.
- **The sentinel could hide a real settlement** if `failPreStart` were ever not terminal. It is terminal by
  contract (`:1938-1960`), and the F1 single-write assertion is the tripwire.

## Non-goals

- Not shape (a); not a spawn-queue change; not a relocation of #439's containment.
- Does not touch `background-pipeline.ts`, the deadline owner, the registry, the scratch/`.done` marker, or the
  containment's getter-backed `agent` read.
- Does not reopen #426 / #449 / #453 / #511.

## Delta budget

- `src/session-manager.ts`: ~**+25 / −10** (one deferred + attachment, the sentinel, the routing in the same
  try, the catch-body narrowing, comment replacement at `:2486-2489`).
- `src/__tests__/session-manager.test.ts`: ~**+18** (one ratchet; no replacement).
- No other file. Flow delta is the gate's `--flow` computation; the expected shape is **0 new files, +1 test**,
  well inside the #540-cycle allowance of 124.

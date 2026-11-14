# 0027. One runtime context per extension invocation, plus injected capabilities, as the seam that lets `index.ts` give up its sections

- **Status:** Accepted
- **Date:** 2026-11-08
- **Issues:** #476 (prerequisite), #430 (first consumer), #474 (coordination), the 2026-11-08 composition-root cycle
- **Related:** ADR 0021 (no CRAP gate; targeted follow-ups), ADR 0026 (boot repair), `.development/investigations/composition-root-context-proposal-2026-11-08.md` (the measured investigation + two plan critiques)

## Context

`src/index.ts` is 4,720 lines; `export default function (pi: ExtensionAPI)` opens at line 433 and runs to EOF — a **~4,288-line closure with 22 nested functions**. It carries the `delegate_task` handler (1,123 lines, complexity 116 / 72% coverage per ADR 0021 — still open as #430), the other three tool handlers, the command surface, three mode runners, the background pipeline, boot recovery and the terminal notifier. ADR 0021 declined a complexity gate and scoped targeted follow-ups; this ADR is the structural seam those follow-ups need.

The investigation measured (proposal §1–§2):

- the closure captures **seven** bindings — `pi` (47 code sites), `log` (120), `state` (172), `sessionCtx` (write 4455 / read 4692), `recoveryNoticeDelivered` (4400/4401/4552), `displayTaskName` (5 reads), and the terminal-subscription trio (4574–4610);
- three are broad: `pi`/`log`/`state` are read by **10 of 16 sections**, including every section that moves 200+ lines; the other four are one- or two-section bindings;
- the 22 helpers form a shallow DAG with exactly **one backward edge** (terminal notifier → `scheduleTransportRetry` → `spawnBackgroundRun`).

Two executable rules bound the design space (both were run against a byte copy of the tree, 11/11 green):

- a non-entry module that imports `index.ts` fails **"the entry point is not a library"** (`architecture-rules.test.ts:212`);
- a non-entry module that imports a session-manager lifecycle mutator fails **"non-entry modules take only the reader API from session-manager"** (`:263`; allow-list `{getAgent, listAgents}`).

So a seam cannot be "the closure, moved": capabilities crossing a module boundary must be **injected**, and data crossing it must be **read-only**.

**Lifetime, stated precisely (critique correction).** `state` is constructed **once per `initExtension(pi)` invocation** (`index.ts:437`), never re-created in `session_start`; the session handlers mutate it in place. `pi` and `log` identities are likewise per invocation. The logger's *sink* is process-global and re-pointed by `setLogCwd(ctx.cwd)`. The context is therefore **per extension factory invocation**, not a process-wide singleton.

**Guard coverage is not closed (critique correction).** The reader-API rule catches named **static** imports; dynamic imports record `names: []` (`architecture-rules.test.ts:113–139`), so `await import("./session-manager")` destructuring passes all 11 architecture tests. S4/S5 depend on such dynamic imports (`markAgentInterrupted`, `updateAgentStatus`, `pruneBackgroundSession`, `retainedSessionPointer`, the steer/stop/retry APIs) and on two numeric `RETRY_SCAN_WINDOW_*` constants (`index.ts:3996,4048,4091`). There are **24** test files importing `../index`, and additional corpus-wide guards beyond the six direct readers — each stage must run the full suite and re-anchor what it breaks.

## Decision

**D1 — the context is exactly three immutable fields.** `src/runtime.ts` exports `RuntimeContext { readonly pi; readonly log; readonly state }` and `createRuntime(pi)`, constructing the `SessionState` that `index.ts:437` constructs today. `index.ts` keeps local aliases (`const { log, state } = rt`) so existing read sites do not change in the same commit.

**D2 — a fourth field needs an argument, in this record.** A future proposal must name the section that owns the value and why that section cannot hold it privately. `sessionCtx` stays a `let` in `index.ts` and reaches the notifier as `getSession`; `recoveryNoticeDelivered` and the terminal trio move into their owning module when it leaves.

**D3 — capabilities are injected, never inherited.** Every extracted module is `create<Section>(rt, deps?)` where `deps` holds **only function fields**. No data in `deps`. Where a stage needs data (the retry-window constants), the constant crosses explicitly in the factory signature and is named in the PR — not captured, not allow-listed.

**D4 — the composition root stays in `index.ts`.** The default export, the seven `pi` surface calls, the session-lifecycle handlers and the `deps` literals that assemble the sections stay. **Registration calls do not move:** S5's modules return *definitions* (tool definition objects, the command handler, prompt strings); `index.ts` performs `pi.registerCommand`/`registerTool`/`on` itself, so registration order, prompt content and registration-time loading are unchanged and testable in place. `index.ts` may not be emptied: `prose-duplication:208` needs a ≥80-char shipped literal there, and `project-flags:217` / `runtime-vocabulary:222` / `logical-runs-453:306` need it to remain a scanned module.

**D5 — latches are per factory instance, never module-private (the blocker).** The terminal-subscription array + release flag, and `recoveryNoticeDelivered`, live **inside the factory closure that owns them**. A module-private latch would be shared by two `initExtension` instances: one shutdown could disable the other's cleanup (two-factory probe: `a=1, b=0` where `b` should be 1). Every extracted notifier factory takes its own latch and is tested with two simultaneous instances, independent shutdown, late and repeated release.

**D6 — extraction is staged, one PR per stage, with a *behavioural* killer per seam.** S0 #476 → S1 pure helpers → S2 mode runners (+ `resolveStepModel`, `applyUnitShapeGuard`, which the fan-out also needs) → **#474** → S3 background pipeline → S4 boot recovery + terminal notifier → S5 registrations → S6 #430's `execute` seams. Each stage re-points the source-text ratchets it touches **in its own commit** — including `taskPrefix` (`architecture-rules:366`) in S3, the anti-capture/anchor pins (`agent-guidance:24`, `conductor-guardrails:15`, `readme-commands:25,53`, `architecture-rules:304,311,345`), `integration:452`, and `status-chokepoint:94` — and each seam carries a killer that **deletes the call and watches the suite redden**; a text-pin change or a compile failure is not a behavioural proof. Moved bodies are compared base→head; required wiring changes are named in the PR.

**D7 — measurable acceptance only.** No complexity number is an acceptance bar here: no tool in this repo produces it (ADR 0021 §1; the handoff's rule). #430's acceptance becomes a **branch checklist + named mutants** for each extracted seam (e.g. bypass the pre-flight ⇒ a specific capability test fails; drop the shape guard ⇒ the batch-guard test fails), all runnable with `npx vitest run`. The test-budget check (`check-test-budget.mjs`, ratio ≤ 2.0) and the full suite are stage gates, not release-only gates.

**D8 — lifetime is per `initExtension(pi)`; process-global facilities are out of scope and named.** `session-manager.agents`, `event-bus.listeners`, `runner.activeChildren`, `notify-completion.terminalClaims` and the logging sink outlive any context; the ADR does not move them and does not call them process-lifetime by accident.

## Consequences

- `index.ts` becomes a composition root of an estimated ~400–700 lines by S5 (arithmetic, not measured); the handler's complexity becomes countable inside a module instead of a 4,288-line closure.
- Six factories replace one closure: a new dependency is a compile error at the factory, not a silent capture.
- Sections become unit-testable without booting the extension (`createRuntime(fakePi)` + function deps), which #430's seams need.
- **Cost, and it is the real one:** the ratchets and text readers. Each stage pays its own re-point in the same commit; the inventory is refreshed after #476 and #474 land, because both change the baseline. S3 in particular must fix the `taskPrefix` pin it would otherwise break.
- **Limit:** the context makes the *data* seam explicit, not cross-module *control* flow; the one backward edge (notifier → background spawn) stays a runtime callback and is invisible to the compiler.
- **Limit:** dynamic imports defeat the static reader-API rule. If D3 is to hold for S4/S5, the rule needs dynamic-destructuring and namespace coverage in a test (or the stage must prove the moved code keeps its lazy-load/error timing behaviourally).

## Alternatives rejected

- **A full seven-field context.** Promotes five two-section bindings to process-wide reach; one closure becomes six closures over a god object; violates interface segregation at the hardest point to unwind.
- **A runtime class with methods.** `erasableSyntaxOnly` forbids parameter properties (measured `TS1294`); kept in one file it moves no lines, split it is the factory design plus a detached-`this` hazard.
- **Per-module structs with no shared container.** Correct for S1; rejected as the whole design because `pi`/`log`/`state` appear in 10 of 16 sections and in every large one.
- **Allow-listing session-manager lifecycle mutators** instead of injecting them. Cheaper for S3, but it lets modules race the agent store and guts the rule's meaning.
- **Moving the terminal notifier first.** It holds the one backward edge, forcing the injection decision before the pipeline exists.
- **A formatter or a complexity gate.** Already rejected in ADR 0021 and #476.

## Open questions

1. #430 is re-scoped to S6 (its `execute` lives in `delegate-handler.ts` after S5) — one issue, not a new one; its acceptance is rewritten per D7.
2. Is S1 + a one-file class (no moves) worth it as a cheaper proof of the review ritual before S2? Default: no — S1's ratchet re-point is the cheaper test.

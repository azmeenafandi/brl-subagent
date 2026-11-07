# #437 — completion wake after session replacement: implementation plan

**Status: AMEND — not approved for implementation.** The independent C1 critique found major gaps in event/crash claim ordering, retry side-effect boundaries and uncertain outcomes, claim-cap guarantees, and graph-local ownership. See `issue-437-plan-critique-2026-11-06.md`; the design and tests below remain superseded until corrected.
**Base:** `dev` @ `1bbdab8` (2026-11-06). **Risk:** C1 — lifecycle, concurrency, dedupe, retry.
**Authority:** source and the actual pi 1.5.0 lifecycle; if this plan conflicts with them, stop and report.
Investigation: `.development/investigations/issue-437-investigation-2026-11-06.md` and #437 comments.

## Recon

`bash .pi/skills/worktree/recon.sh deliverCompletionAlert --grep` at `1bbdab8`: one graph caller
(`src/index.ts`), 22 affected symbols across 21 files; five raw text hits. The terminal path invokes
`claimTerminalNotice`, resolves the run through `state.getRunEntries(ctx)`, handles retry, and sends.
`recon.sh sendCompletionNotification --grep`: two graph callers (`deliverCompletionAlert` and the
containing file), 23 affected symbols across 22 files; five raw hits. Graph gap: `codegraph node
 eventBus` selected an unrelated test mock; `src/event-bus.ts` was read directly to inspect its
module-level listener sets, insertion-order iteration, and `off(type, listener)`.

## Evidence and correction

- Live controlled sequence: startup wake delivered (`8c93056c`); after `/new`, run `349edba0`
  completed but the handler logged a stale-context error and no wake appeared; after user-triggered
  `/reload`, run `1781a028` delivered. This is one reproduced sequence, not a universal guarantee.
- The investigation's real pi 1.5.0 loader probes show `/new` re-invokes the extension factory while
  sharing the module graph, retaining obsolete listeners and the shared terminal-claim set. A real
  two-generation factory/bus scratch test reproduced the failure: the obsolete listener claims first,
  then `state.getRunEntries(ctx)` throws at the stale `ctx.sessionManager` getter; the live listener
  sees the consumed claim. The issue body's claim that `pi.sendMessage` throws first is incorrect.
- Scratch retry tests found zero retry spawns on the original two-generation setup versus one on the
  proposed candidate. Existing retry, completion, and dedupe tests pass on baseline. The copied-tree
  test environment has a known unrelated missing-preset fixture failure; do not use it as the gate.
- The investigation's candidate C (per-generation gate + exact unsubscription + later claim) passed
  its six scratch lifecycle cases and two retry cases. It has **not** been verified live in pi, and
  retry-in-flight replacement and the poller stale-handle path remain unproven end-to-end.

## Scope and policy

**Maintainer decision:** users should avoid `/new` while runs are active. This fix must restore
completion delivery and transport auto-retry for runs started **in the current live session after** a
replacement. Cross-replacement delivery for runs already active during `/new` is not a requirement;
do not promise durable handoff or exactly-once across that boundary. No new automatic guard is implied.
Runs straddling a transition, including their stale poller and persistence behavior, are a separate
investigation/follow-up, not a reason to weaken ordinary-session deduplication.

The notification knob's existing matrix, message payload, stop behavior, crash-notice dedupe, retry
eligibility, one-retry limit, source suppression and fallback must stay unchanged. No global event-bus
clear, dependency, timeout feature, or unrelated refactor.

## Design — per-generation listener ownership

Use the investigation's Option C as the starting design, **not an exact patch to copy**. In
`src/index.ts`, explicitly own the terminal listener closures for each runtime generation:

1. Establish a module-graph-shared generation/ownership token when the active `session_start`
   initializes that generation. Register or track exact completed/failed/stopped listener functions;
   use a synchronous ownership gate before any claim or asynchronous work. Obsolete generations must
   not consume the claim or touch stale `pi`/`ctx` handles. Handle the factory-loaded-but-not-started
   window without claiming; never assume `session_start` supplies a new `pi` object.
2. At the **start** of `session_shutdown`, deactivate that generation and remove **only its own**
   listener functions with `eventBus.off`, idempotently, in a path that survives cleanup exceptions.
   Do not unsubscribe listeners owned by another generation or another event-bus consumer. Preserve
   existing shutdown cleanup and foreground-child reaping. A missed or failed shutdown must not let
   an older generation consume claims after the newer generation starts.
3. Resolve the live context, agent and run before acquiring the shared terminal claim; a missing
   context or unknown agent must not consume it. After any asynchronous boundary, re-check ownership
   before using generation-bound handles. Acquire the claim synchronously **before** retry or send so
   duplicate terminal events/crash notices cannot cause duplicate notifications or retries.
4. Audit `scheduleTransportRetry`: it awaits work and itself calls `ctx.ui.notify` before returning.
   An ownership check only **after** the caller awaits it is therefore insufficient to prevent a
   stale toast/side effect. Guard every generation-bound continuation at its actual point of use,
   including retry spawn/notification and completion send. Preserve fallback on genuine spawn failure.
5. For absent context, failed delivery, or a transition during an await, leave a diagnostic where a
   valid logger exists; do not claim a wake was delivered. If no live listener exists, no universal
   diagnostic is promised. Do not add a persistent sentinel or handoff queue in this fix.

The precise solution for a claim acquired just before a transition must be stated in the PR and tested.
It must neither duplicate a retry/send nor prevent later **same-session** terminal handling; it need not
deliver a run that straddles `/new`. Avoid releasing a claim blindly after a successful send or spawn.

## Required tests and falsifiers

Create a focused lifecycle test using the **real extension factory**, real shared event bus and shared
claim surface; simulate old/new runtime handles that throw when stale. State expected failing test and
failure signature before each mutation. Use isolated test module state and preserve unrelated listeners.

| ID | Required observable |
|---|---|
| L1 | Baseline: fresh generation sends one completion with correct id, payload and delivery options. |
| L2 | Old start → shutdown → stale handles → new start → new-session completed/failed/stopped events: exactly one appropriate wake from the new generation; no stale-handle access. Demonstrate current source fails before applying the fix. |
| L3 | Missed/throwing old shutdown followed by new start: old generation cannot claim, send, or retry; new one handles the event once. |
| L4 | Loaded-but-not-started, missing context and unknown agent do not consume the claim; a subsequent valid owner/event can handle that id. |
| L5 | Shutdown idempotency and **listener cleanup**: exact registrations are removed; no listener growth after repeated generations; unrelated listener remains. Observe registration/removal by matching function identities or a test-only counting seam, not just successful wakes. |
| L6 | Duplicate terminal events and the existing crash-notice path yield at most one notice; no duplicate retry. |
| L7 | Transport failure after new-session start: one attempt-2 spawn using live handles, source notice suppressed only if scheduled; rejecting/throwing spawn falls back to one source notice; attempt 2 never chains. |
| L8 | Deterministically pause before/within the retry's awaits and during session shutdown: no obsolete send, spawn, or toast after ownership is lost; assert the chosen claim outcome and no unhandled rejection. Do not rely on a sleep for race ordering. |
| L9 | Preserve the existing `completionNotify` delivery/wake matrix and completed/failed/stopped payload semantics. |

Named mutants, each applied to the unique production target in a scratch copy, then run against its
named targeted test with the expected failure confirmed:

- **M-off:** omit the generation's `eventBus.off` → **L5** detects retained listeners. The gate can
  mask this defect in L2; a successful wake alone is not a leak test.
- **M-gate:** remove the obsolete-generation gate → **L3** detects stale claim/handle use or lost wake.
- **M-claim:** acquire the claim before checking for a missing/unknown agent → **L4** observes the
  subsequent valid event suppressed. A startup-window-only test is insufficient because the gate may
  prevent the handler from running at all.
- **M-race:** remove the selected post-await/point-of-use ownership guard → **L8** observes a stale
  handle side effect or unhandled rejection. Identify the exact guard and failing assertion before the
  run; do not count a non-discriminating mutant as a kill.
- **M-dedupe:** bypass the shared claim → **L6** observes duplicate notification or retry.

All named mutants must be killed by the committed suite, not merely a separate diagnostic harness.
Tests should assert the real notification/retry boundary and status; avoid claim/set-only assertions
except where the test specifically detects a leak or a lost claim.

## Gates and live verification

- Prepared worktree for all source/tests; no package-manager install in the cockpit. Run targeted new
  and existing completion/dedupe/retry suites, `npx vitest run`, `npm run typecheck`, docs gates, and
  `git diff --check`. Document commands and counts; C1 adversarial review before merge.
- With maintainer-triggered activation/reload of the fixed install, reproduce startup → `/new` → new
  run completion → `/reload` → new run completion. At each stage verify visible wake, matching run id
  and relevant log output; check failed/stopped where safe. Do not dispatch a run across `/new` as an
  acceptance requirement. Keep the current session separate from the live probe.
- A merged extension-code change opens the existing release checkpoint; no release without maintainer
  approval. The fix is not live for published users until release.

## Follow-ups, not prerequisites

- Investigate separately whether a straddling settle loses its session run entry or recovery signal,
  and whether the old poller's stale send can claim first. Current evidence is code inspection and
  scratch API behavior, not an end-to-end reproduction.
- The earlier post-`/reload` missing wake remains unexplained; the controlled `/reload` succeeded.
- Critic must challenge module identity, listener ownership, shutdown ordering, claim/error semantics,
  race tests and the proposed mutants before this becomes an implementer dispatch.

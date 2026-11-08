# Issue #437 plan critique — 2026-11-06

> Independent critique by `project-plan-critic`, run `db177190`; source `/tmp/CRITIQUE_437.md`.

Verdict: needs-work

# Issue #437 — final-draft plan critique

This is the requested AMEND outcome. Scope is the final plan, not an implementation review. The scratch candidates are illustrative experiments, not proposed production patches. No repository file was modified. Base `1bbdab8ca48d13529d5db47a9f8caecb839a9389`; pi 1.5.0; Node v24.14.1; vitest 5.0.5. The two authoritative investigation documents were read from this worktree, where both are untracked. `gh issue view 437 --json title,body,comments,state` and `gh issue view 437 --comments` show the body and all four comments, including the later maintainer policy.

## Severity-ranked findings

### Major 1 — Claim-last changes the event/crash winner, not just dedupe

**Plan:** Design step 3, L6, lines 63–66 and 92. `src/index.ts:4210–4232`, `src/notify-completion.ts:279–288`, `src/index.ts:2021–2030`, `src/recovery-surface.ts:365–370`.

The plan requires resolving agent/run before claiming, but the current handler reserves synchronously, before `await import`. The shared set is also used by the poller and abandonment. On candidate C, an event followed in the same turn by the competing claim gives `crashWon=true, sends=0`; the baseline gives `crashWon=false, sends=1`. This direct shared-claim experiment simulates the competing crash's claim, not the whole timer/poller. It demonstrates a real ordering change: an eventual crash notice can replace the canonical completion (and preempt its retry), even though L6's at-most-one assertion passes.

**Reproduce:** `BRL437_SRC=/tmp/brl437/{base,candC}/src ./node_modules/.bin/vitest run --root /tmp/brl437 test/critic-lifecycle.test.ts -t 'event-first' --reporter verbose` (run each variant separately). Baseline passes; candidate C fails `expect(crashWon).toBe(false)`.

**Fix/falsifier:** Specify a synchronous, shared event-first reservation or synchronous validation/claim before asynchronous work, with crash and abandon users participating in the same ordering. Unknown agent/missing context must not permanently poison the ID. Test *actual* event then actual crash, both invocation orders, before and after event-handler await; require canonical completion or retry when event is first, not merely count=1. An event-first crash win falsifies compatibility.

### Major 2 — Retry's inner continuations outlive a caller-side gate

**Plan:** Design step 4 and L8, lines 67–70, 94. `src/index.ts:scheduleTransportRetry`, `spawnBackgroundRun`, `startBackgroundAgent` (`:4157–4205`, `:2247–2419`, `:1956–2051`); `src/session-manager.ts:1188–1436,1888–1903`.

The plan correctly flags the toast but does not resolve where the asynchronous spawn is committed, canceled, or accounted for. `spawnBackgroundSession` waits on a module queue and imports/loader/session creation, then persists a record, appends a run, emits and starts the prompt; `startBackgroundAgent` registers live state, increments a counter and paints **after** its await. An outer guard before/after `await spawnBackgroundRun` cannot revoke this work. With a deferred mocked real-factory spawn, shutdown and then release: candidate C reads stale `ctx.ui`; when ctx is intentionally still usable after ownership was deactivated, it produces one retry toast after shutdown. The completed deferred call had already begun before shutdown; the experiment does not prove a late SDK spawn itself occurred.

**Reproduce:** `BRL437_SRC=/tmp/brl437/candC/src ./node_modules/.bin/vitest run --root /tmp/brl437 test/critic-retry.test.ts -t CRITIC` and `... test/critic-retry-live.test.ts -t CRITIC`. Both fail `reads=[]`; outputs respectively `reads=["ui"]` and `reads=["ui","ui","ui"], notified=["Transport failure — auto-retrying once (attempt 2/2)"]`.

**Fix/falsifier:** State the actual point of no return and pass ownership/cancellation checkpoints through every *generation-bound* continuation down to the point of use; avoid claiming that already-committed external work can be undone by a later check. Distinguish not-started, started/committed and outcome-unknown; clean up partially-created resources without changing retry policy for live sessions. If no-obsolete-spawn means no asynchronous side effect after ownership loss even when spawn was already invoked, this cannot be achieved by guards in the caller alone: either thread cancellation/cleanup through the actual spawn lifecycle or narrow that acceptance explicitly. No queue or /new guard is needed. Deferred tests must interrupt before each import/queue wait, inside SDK/session creation, after spawn and before repaint/toast; assert actual persist/emit/spawn, state mutations and toast counts, no unhandled rejection, and the claim state. Any obsolete call/read or false scheduled/failed result is the falsifier.

### Major 3 — Failure/claim state machine is not specified; “throw = no spawn” is false

**Plan:** Design steps 3–5 and L7, lines 63–76 and 93. `src/index.ts:1985–2051,2357–2419,4170–4236`; `src/notify-completion.ts:287–288`.

L7 groups rejected/throwing spawns and says each falls back, but a throw can occur *after* the retry exists. The scratch test makes mocked `spawnBackgroundSession` return a started agent, then makes `ctx.ui` throw from `startBackgroundAgent`'s post-spawn repaint. Both base and candidate C record `spawnCalls=1, sourceMessages=1`: an actual retry has been started while a source failure is also sent. This is an existing ambiguity, not a newly proven candidate regression; it disproves the proposed unconditional fallback/source-suppression assertion. A real SDK partial failure or process crash was not exercised.

Likewise `sendMessage` can throw before or after accepting a message; the caller cannot infer non-delivery from a thrown exception. In a real-factory fake-send experiment, both modes were attempted only once and logged; accepted=false had zero messages, accepted=true had one. Releasing on all throws would trade the first loss for duplicates in the second case.

**Reproduce:** `BRL437_SRC=/tmp/brl437/candC/src ./node_modules/.bin/vitest run --root /tmp/brl437 test/critic-spawn-fail.test.ts -t CRITIC` (base gives the same); `... test/critic-lifecycle.test.ts -t 'critic send throw' --reporter verbose` (both accepted=false/true pass, one attempt each).

**Fix/falsifier:** Specify an owner-tagged claim/reservation lifecycle with these cases: missing context/unknown agent/failed validation before any side effect release only that owner's provisional reservation; duplicate events and crash/abandon compete through it; definite pre-spawn rejection holds exclusivity through exactly one fallback send; successful spawn or send commits, never blindly releases; send-throw or partially-started/unknown spawn conservatively retain a claim and log the uncertainty unless a real negative acknowledgement proves no action. Ensure failures after a successful retry spawn cannot masquerade as pre-spawn rejection. A crash that loses to a provisional event claim must not disappear silently if that provisional claim is then released; synchronous validation avoids that race, otherwise arbitration needs its own test. Test a re-entrant duplicate while spawn awaits, fallback failure, synchronous throw, rejected promise, spawn-then-paint failure, and send-before/after-accept throws; the exact counts plus diagnostic are the falsifiers. Avoid claiming guaranteed delivery when outcome is unknowable.

### Major 4 — Unconditional L6 conflicts with the existing, tested 200-id cap

**Plan:** Scope unchanged dedupe and L6, lines 43–44 and 92. `src/notify-completion.ts:266–288`; `src/__tests__/notify-completion.test.ts:402–451`.

The 201st claim adds its own id and immediately clears the entire set, including that id. With 200 filler claims followed by two same-id terminal events, both base and candidate C send twice. This is a pre-existing cap limitation, not a #437 regression, but “unchanged dedupe” and unconditional “at most one” cannot both be accepted as stated. A reservation only while awaiting is insufficient if it disappears immediately after the first synchronous send and the committed set was cleared.

**Reproduce:** `BRL437_SRC=/tmp/brl437/base/src ./node_modules/.bin/vitest run --root /tmp/brl437 test/critic-lifecycle.test.ts -t 'claim cap'` and repeat for `candC`: `CAP-RACE {"sends":2}` each. Existing tests explicitly expect earlier IDs to be forgotten after overflow.

**Fix/falsifier:** Either bound L6 to the existing retention contract and explicitly report the overflow residual, or make a minimal separately justified bounded-claim correction that retains the currently committed ID without silently changing all historical retention semantics. A test must force the 200→201 boundary, issue immediate duplicates, and distinguish in-flight from committed claims. Do not claim an unlimited exactly-once property.

### Major 5 — Shared ownership is graph-local; reload and duplicate-start cases need explicit bounds

**Plan:** Design steps 1–2, L2/L3/L5/L8, lines 53–62 and 88–94.

Real pi loader probes confirm same-cwd successive loaders usually reuse the graph and same-loader reload clears it. But `loader.js:98–103,554–558` clears the global cache on a cwd change even with an empty extension list. Real probe: an owner loader at `/tmp/brl437-probe`, then a `noExtensions` child loader at `/tmp`, then another owner loader at the original cwd produces generation 1 both times (fresh graph). This is relevant to `spawnBackgroundSession`, which makes a no-extensions loader for the effective task cwd. Module marker in this probe is global and is NOT identity evidence; reset generation and listener set are.

A graph-local token cannot revoke an old graph. Scratch `vi.resetModules` with missed A shutdown, stale A, then B startup and an event emitted on *old* bus produces `staleWarn=true,A=0,B=1` when B's own new bus subsequently emits. It does NOT show B's new-session events can enter the old bus. This is an adversarial old-event/straddling case, not a requirement to hand off a straddling run. A duplicate `session_start` on A after B starts also makes illustrative candidate C give `A=1,B=0`; pi's normal runtime serializes teardown and replacement (`agent-session-runtime.js:103–169`), so this is an adversarial shape, not proof pi actually replays old starts. A `session_start` after a shutdown can also reactivate a token after its listeners have been removed unless lifecycle states are explicit.

**Reproduce:** `node /tmp/brl437-probe/critic-child-loader.mjs`; `BRL437_SRC=/tmp/brl437/candC/src ./node_modules/.bin/vitest run --root /tmp/brl437 test/critic-lifecycle.test.ts -t 'critic reload fresh graph'`; same with `-t 'duplicate old start'`.

**Fix/falsifier:** State same-graph versus fresh-graph guarantees and the pi sequencing assumptions. Keep deactivate/off first in shutdown, not candidate C's post-reap cleanup. Use explicit never-started/active/stopped behavior; stale/duplicate old starts must not take over B, and a shutdown must never revoke B. Test same-graph overlap and clean reload/new graph independently, including cleanup throws and duplicate hooks. For a truly missed shutdown plus fresh graph, either explicitly exclude old-graph straddling work under maintainer policy or identify a host-backed cross-graph invalidation mechanism; do not assert the graph-local token solves it. `/reload` emits `session_start` only when host has bindings (`agent-session.js:3041–3046`); scope host acceptance accordingly.

### Major 6 — Named gate mutant can survive the named test

**Plan:** M-gate/L3 lines 89 and 102. Candidate C has both an outer gate and an independent post-import gate. Deleting only the unique outer listener gate leaves the post-import gate intact. The existing missed-shutdown test passes for both: A sends 0, B sends 1, no stale warning. Thus neither lost wake nor stale-handle assertion necessarily kills the single-site mutant. Instrumenting the real `getAgent` entry shows control 1 lookup versus mutant 2, while both still send once.

**Reproduce:** `BRL437_SRC=/tmp/brl437/critic-gate/src ./node_modules/.bin/vitest run --root /tmp/brl437 test/lifecycle-red.test.ts -t 'MISSED SHUTDOWN' --reporter verbose` (passes); `... test/critic-lifecycle.test.ts -t 'critic wrapper gate'` (fails `lookups=2`, candC passes with 1). An initial mock-based concurrent dynamic-import probe timed out due to its scratch harness; it is NOT a mutant kill.

**Fix/falsifier:** Name the exact gate being removed. If the requirement really is “no obsolete asynchronous work”, count obsolete-generation lookup/continuation invocation in addition to asserting one correct live send. If only stale effects and claims matter, the pre-import gate is redundant in this shape and the mutant may legitimately survive; adjust the rationale rather than counting it as killed. For post-await guard mutations, use separate deterministic pauses and assertions.

### Minor — Host acceptance must distinguish delivery from wake, and count 9 matrix cases

**Plan:** L2/L9 and live verification, lines 88, 95, 119–122. `resolveDelivery` (`src/notify-completion.ts:250–258`) always sends, but `failed`/`off` can suppress a turn. Existing pure unit coverage is all nine status × knob combinations (`notify-completion.test.ts:375–390`); existing full factory matrix covers only the three failed rows (`terminal-notice-dedupe.test.ts:438–468`).

**Fix/falsifier:** In L2 use three distinct run IDs, otherwise the shared per-ID claim intentionally suppresses later events. At live acceptance use `all` or say “message delivered” rather than “visible wake” for `failed/off`; test all nine classified statuses/knobs at the real-factory send boundary, with payload and options. Repeated use of one id or expecting triggerTurn=true for off is a vacuous or incorrect matrix test.

## Measured mutation map and harness constraints

All mutation experiments were performed only on scratch copies; no committed suite exists yet, so **none is a demonstrated committed-suite kill**. The sample `candC` is not claimed correct.

| Mutation | Unique scratch mutation / targeted killer | Observed red/green |
|---|---|---|
| M-off | `/tmp/brl437/critic-off/src/index.ts`: omit only `eventBus.off`; L5-style count seam and unrelated listener | parent leaves completed=1; mutant completed=5, failed=4, stopped=4 after four generations. Parent green, mutant red. |
| M-gate | `critic-gate`: remove only synchronous wrapper gate, keep post-await guard; obsolete `getAgent` count | old missed-shutdown test GREEN on both. Added lookup assertion parent=1, mutant=2 and both send one; mutant RED. |
| M-claim | existing `candCmut`: move claim before validation, retain gate; unknown-id event then create agent and re-emit | parent GREEN; mutant RED, 0 sends. Original six lifecycle tests GREEN even on mutant, as the plan warns. |
| M-race | `critic-toast-parent` has scratch-only pre-toast ownership guard and completion seam; `critic-toast-mut` removes that single guard, later caller gate retained | parent no toast; mutant RED one toast after loss. This is an isolated guard discrimination experiment, NOT proof the parent protects internal spawn/repaint. |
| M-dedupe | `critic-dedupe` bypasses only terminal-handler shared claim; duplicate same-id emits | parent GREEN one send; mutant RED two sends. Also test both actual poller-crash orders and retry count. |

A minimal committed harness should invoke the real factory, bus, claim surface and send boundary, with fake old/new `pi`/`ctx`, independently stale flags, and per-test module isolation. Mock only blocking external spawn/import seams; use deferred promises or explicit completion callbacks for ordering, not arbitrary time delays. Count exact registered/off identities; install an unrelated listener. Scratch lifecycle tests use a 60 ms flush, so their red/green is evidence for the described experiments, not a model for the committed non-flaky race test. The race probe uses an explicit deferred promise; `vi.waitFor` is only used to await observation, not to arrange the race.

## Required ordering constraints for the implementer

1. Before implementation, pin real-loader same-graph and fresh-graph cases, event-first crash precedence, unknown-agent retry, cap boundary, partial-spawn and send-outcome tests. Record expected current red versus existing-baseline limitation; do not label known baseline limitations regressions.
2. Define owner state and shared provisional/committed claim transitions, including the no-side-effect-only release condition. Deactivate/unsubscribe synchronously at the start of shutdown; keep foreground-child reap and existing cleanup even if one part throws, without touching another generation's subscriptions.
3. Trace and test each retry continuation and side-effect point, preserve attempt 2, source suppression and genuine pre-spawn-failure fallback. Do not treat an already-started retry as a rejected one or promise cancellation of an irreversible action.
4. Run the five exact one-site mutations with their matching committed tests, record parent green/mutant red and failure signatures; then run targeted suites, full suite, typecheck, non-writing docs gates and diff checks in the prepared worktree. Review before merge; maintainer triggers live verification and release approval.

## Verified sound and reproduction provenance

- `git status --short; git rev-parse HEAD; pi --version; node --version; ./node_modules/.bin/vitest --version`: only two untracked source documents; base 1bbdab8; pi 1.5.0, node v24.14.1, vitest 5.0.5. `diff -qr src /tmp/brl437/base/src` returned 0 differences before scratch experiments.
- `gh issue view 437 --comments`, `gh issue view 437 --json ...`: issue body plus four comments, including explicit current-live-session-only maintainer scope; no automatic guard, straddling handoff, durable queue or mandatory straddling acceptance is justified.
- `node /tmp/brl437-probe/driver.mjs; node .../driver2.mjs; node .../driver3.mjs; node .../driver4.mjs`: repeated activation generations 1→2→3 on one set; clear/same-loader reload resets to 1; invalidated `sendMessage`, `appendEntry`, `getFlag` throw. pi source separately confirms stale ctx getters. These are loader/API probes, not a patched interactive host test.
- `BRL437_SRC=/tmp/brl437/base/src ... vitest ... lifecycle-red.test.ts retry-across-generations.test.ts`: 7 fail/1 pass, A=0/B=0, retry spawns=0. Same command with candC: 8/8 pass. Existing candidate coverage is not retry-in-flight coverage.
- `bash .pi/skills/worktree/recon.sh deliverCompletionAlert --grep` gives 1 caller/22 symbols/21 files/5 raw hits; analogous `sendCompletionNotification` gives 2/23/22/5. Graph gap is covered by direct `src/event-bus.ts` read. `rg -n 'eventBus\.(on|off|emit)\(' src --glob '*.ts'`: 1 production on, no production off, 10 production emits and 5 test emits; 16 total matches. `rg -n 'claimTerminalNotice|markTerminalSeen|__resetTerminalClaims' src` gives the three production shared-claim call sites, including abandon. Empty production off query: `rg -n 'eventBus\.off\(' src --glob '!**/__tests__/**'` printed no matches and returned 1.
- `./node_modules/.bin/vitest run src/__tests__/terminal-notice-dedupe.test.ts src/__tests__/transport-auto-retry.test.ts src/__tests__/notify-completion.test.ts`: 3 files, 80/80 pass on base. `npm run --silent typecheck`: exit 0. `node scripts/docs-arch.mjs --help` and `node scripts/docs-decisions.mjs --help` execute their default check: 47 modules and 22 decisions current. The package scripts add `--write`; use direct check commands for a non-writing gate.
- Baseline start → replacement defect, policy scope, no global event-bus clear, exact off identities, and explicit L5 no-leak test are sound. A controlled live startup/new/reload sequence is useful when maintainer-triggered; previous bare-reload loss remains unexplained, so it is not proven fixed.

## Residual risks and open questions

- Patched live pi was not exercised; full repository test suite and adversarial review were not run. Scratch tests mock parts of spawning, and stress/model ordering beyond the named scenarios is unproven.
- Poller/stale persistence and delivery of work straddling replacement remain out of scope. The plan must not promise retrieval, diagnostics, or a successful completion for such runs merely because the notice listener is fixed.
- The concrete point of no return, cleanup of partially-created retry session state and how to distinguish a rejected spawn from one already started must be resolved in the implementation design; current `ToolResult.isError` does not encode that distinction.
- The untracked plan and investigation are local evidence only, not enforceable shipped instructions. Commit executable tests and applicable PR design assumptions; do not rely on these documents being in the PR.
- `SOLID/DRY violations flagged: n/a — plan-only critique; no implementation diff reviewed.`

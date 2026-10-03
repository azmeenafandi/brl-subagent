# Investigation — background completion wakes stop after `/reload`

**Status:** RESOLVED 2026-09-22 — no defect. Wakes deliver promptly when the conductor is idle (0.0 s) and queue until a quiet turn boundary when it is mid-turn. The original alarm was a biased-baseline sampling artifact (see FINAL + friction `biased-baseline`).

## Symptom
After the `/reload` at **12:47:23Z** (which loaded dev@bf48292, all four sprint fixes),
background-run completion notifications stopped entirely:
- 2 background probes dispatched post-reload (`991215c7`, `e9889eac`) — both settled
  correctly (log `Background run settled`, run records `status:done stopReason:stop`),
  **neither produced a `customType:"subagent-completion"` message** in the session store.
- Today's notification count: 14 before the reload (last `12:09:22Z` for `verify-186-rev`),
  **0 after**.

## Evidence gathered
- Settle path is sound: `Background run settled` logged for both probes; run entries written.
- `/reload` DOES re-emit the lifecycle: `Session shutting down` 12:47:23.455Z +
  `Session started` 12:47:27.139Z (presets reloaded from the dev checkout) — so
  `session_start` handlers ran, `sessionCtx` should be re-captured, auto-route works.
- Extension registry: single copy (local path), no duplicate.
- No `completion-push handler failed` warning in the extension log — so the handler
  either never ran or hit a silent `return` (dedupe / `!ctx` / `!agent`).
- Pre-reload, the same process delivered wakes reliably (14 entries today from 10:12Z).

## Hypotheses (ranked)
1. **Reload does not re-arm the completion-push**: the `eventBus` subscription and the
   captured `pi` handle (extension factory closure) belong to the pre-reload runner.
   If pi's `reload()` invalidates the old runner and does NOT re-run the extension
   factory, `pi.sendMessage` from the stale closure may silently no-op while the
   handler still runs (no warn).
2. The factory DOES re-run, but something in the new code path (four merged PRs)
   prevents delivery — less likely (no code touches the subscription/notify path;
   `#185` added only an import edge `notify-completion → state`).

## Discriminator (next step)
Full pi restart (fresh process, extension loads as dev@bf48292):
- dispatch one background probe → if `subagent-completion` appears → reload-specific defect.
- if still absent → the merged code is implicated; bisect from there.

## Verification surface
- Session store: `~/.pi/agent/sessions/--home-azmeen-public_projects-brl-subagent_workspace-brl-subagent--/*.jsonl`
  — look for `"customType":"subagent-completion"` (successes) / `"subagent-notification"` (failures).
- Extension log: `.pi/subagent-logs/brl-subagent.log` (`Background run settled`).

## UPDATE 2026-09-22 ~13:05Z — probe 1's wake ARRIVED (late); latency is the anomaly

- `postreload-bg` (991215c7) wake was WRITTEN to the session at **13:00:31.616Z** —
  **567.6 s after its 12:51:03 settle**, exactly at a conductor turn boundary.
  Content correct: label/id/duration/cost/`category: success` + output tail `DONE`.
- Pre-reload comparison (14 runs today): settle→notification-write deltas were **0–7 s**
  (e.g. `d760bec7` 0.0 s, `49c967ec` 5.3 s) — including runs that settled while the
  conductor was mid-turn.
- `postreload-bg2` (e9889eac, settled 12:56:08) had **no wake entry** at T+5 min.

### Revised assessment
The completion-push is ALIVE post-reload but DELAYED (seconds → many minutes).
It eventually flushes at a turn boundary. Two candidate causes:
1. `/reload` leaves the push in a state where delivery is queued/deferred
   (e.g. the fresh `pi`/runner + old subscription interaction), vs immediate pre-reload.
2. Delivery depends on turn-boundary flushing that happened to align badly in this
   window — but pre-reload mid-turn deliveries were 0–7 s, so this alone is weak.

### Next test
Full pi restart → dispatch one background probe while the conductor is BUSY:
- wake within seconds ⇒ `/reload` caused the deferral (file issue; fix re-arming).
- wake still delayed/absent ⇒ fresh-process regression in the merged code — bisect.

## UPDATE 2 — both wakes arrived; latency pattern is turn-boundary flushing

- `postreload-bg2` (e9889eac, settled 12:56:08.776): wake written **13:01:54.806Z**
  (= **346.0 s**), again exactly at a conductor turn boundary (the next one after probe 1's).
- So both post-reload wakes arrived, in order, one per turn boundary.
- IMPORTANT CONFOUND: every pre-reload sample (0–7 s deltas) was taken while the
  conductor was IDLE (waiting for the wake). Both post-reload probes settled while the
  conductor was MID-TURN (running verification). So the pre/post-reload difference may be
  conductor activity, not the reload.
- Remaining discriminator: restart pi → dispatch a probe and keep the conductor BUSY →
  measure. Seconds ⇒ `/reload` causes the deferral; minutes ⇒ normal busy-queue behavior
  (pre-existing, not reload-specific).

## UPDATE 3 — fresh process (restart) shows the SAME busy-deferral ⇒ no reload defect

- pi restarted at 13:03:21/23Z (fresh extension load from the dev checkout).
- Probe `postrestart-bg` (e902c65a): spawned 13:04:18, settled **13:04:20.406Z** (done/stop, 2 turns).
- Conductor stayed deliberately BUSY (80 s of continuous mid-turn polling): **no wake entry
  appeared mid-turn** — identical to the reloaded process.
- ⇒ Busy-deferral is NOT reload-specific (a fresh process defers too); the pre-reload
  "0–7 s" deltas were all measured while the conductor was IDLE.

**Working model (matches all 18 runs to date):**
- conductor idle at settle ⇒ prompt delivery (0–7 s);
- conductor mid-turn at settle ⇒ message queued, delivered at a turn boundary.

**Status:** scare resolved. No defect in the merged code; no `/reload` regression established.
Remaining: confirm the idle path in the fresh process (one probe, conductor idle).

## FINAL — resolved: no defect; it is conductor-activity-dependent queueing

Fresh-process runs (pi restarted 13:03:21/23Z):
| probe | settle | wake written | delta | conductor at settle |
|---|---|---|---|---|
| postrestart-bg (e902c65a) | 13:04:20.406 | 13:07:06.315 | 165.9s | busy |
| postrestart-idle (7a3c6e23) | 13:07:25.606 | 13:09:11.832 | 106.2s | busy |
| postrestart-idle2 (862d73ce) | 13:09:24.914 | 2026-09-22T13:09:53.346Z | 28.4s | busy |

Cross-check: all 14 pre-reload 0–7 s deliveries occurred while the conductor was IDLE
(waiting on the wake). The reloaded process and a freshly restarted process behave
identically for the busy case. ⇒ The earlier "wake is dead after /reload" panic was a
sampling artifact: the probes settled while the conductor was mid-turn, so the messages
were queued (pi's follow-up/steer semantics) and flushed at a later turn boundary.

**Conclusion:** no defect in the merged code; no `/reload` regression demonstrated.
Behavior: idle at settle ⇒ prompt (0–7 s); mid-turn at settle ⇒ queued until a quiet
turn boundary (seconds to minutes depending on conductor activity). Exact boundary
selection is pi-internal and not further characterized.

| idle-path-final (e8a81fc6) | 2026-09-22T13:10:53.822Z | 2026-09-22T13:10:53.848Z | 0.0s | **IDLE** |

IDLE path confirmed prompt in the fresh process — matrix complete:
idle ⇒ seconds; mid-turn ⇒ queued to a quiet turn boundary.

**Follow-ups:** none required. (If prompt delivery while busy is ever desired, that is a
pi-level delivery-semantics question, not an extension defect.)

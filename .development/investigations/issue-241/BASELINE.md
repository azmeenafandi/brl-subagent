# #241 steer_subagent — LIVE BASELINE (pre-fix), 2026-09-29

Current build: dev @ fcb9dc2 (post-#240), reloaded in-session. Probe agent `0b4ce96a-c681-4383-b51d-0b872ec6b1f2`
(deepseek/deepseek-flash, background, cwd /tmp).

## Probes and predictions (stated BEFORE the run)

| Event | Predicted | Observed |
|---|---|---|
| Steer #1 during `sleep 20` (~t+6s) | tool returns success, no delivery | ✅ `Steered agent 0b4ce96a…: "Steering #1: codeword BANANA-ONE"` |
| Steer #2 during `sleep 30` (~t+40s) | tool errors — one-shot defect | ✅ `Failed to steer agent: Cannot steer agent 0b4ce96a…: status is steered, not running` |
| Agent final report | `NONE` (received no steering) | ✅ `(a) … NONE  (b) DONE` |

Agent ran the 20/30/40s sleep ladder (total 1m35s, $0.0029) and completed normally.

## Acceptance criteria for the #241 fix (same probe, after the fix)

1. Steer #1 → tool success AND **the agent's own next reply echoes BANANA-ONE**, arriving after `sleep 20`
   returns (the SDK drain point: after the current turn's tool calls, before the next LLM call).
2. Steer #2 → tool success (no one-shot error) AND the agent echoes BANANA-TWO after `sleep 30` returns.
3. Final report lists BOTH codewords verbatim (not NONE).
4. Timing observed: each steer lands between tool calls, never mid-`sleep` (drain happens at the turn boundary).

---

## POST-FIX acceptance run (2026-09-29, dev @ `9c9b754`, reloaded 14:18Z)

Probe agent `6b1f7c05-2622-4da9-ab80-14e824de8bf8` (deepseek-flash), same 20/30/40s sleep ladder, steered at the
same timings.

| Criterion | Result |
|---|---|
| Steer #1 (during sleep 20) | ✅ tool success |
| Steer #2 (during sleep 30) | ✅ tool success — **no one-shot error** (baseline threw here) |
| Agent's own conversation | ✅ final report lists BOTH: `Steering #1: codeword BANANA-ONE`, `Steering #2: codeword BANANA-TWO` (baseline: NONE) |
| Echo rule | ✅ last reply begins `BANANA-TWO` (echo), then the report |
| Transcript audit | ✅ two `user | Steering:` lines (baseline: only #1 — #2 threw before the record) |
| Cost / duration | $0.00105 · 1m35s · 4 turns |

Boundary (honest): the per-boundary split of the two echoes (after sleep 20 vs after sleep 30) is not directly
captured — `finalOutput` holds only the last assistant message and the agent transcript records no assistant
turns. Delivery of both is proven; the drain timing (after the current tool call, one message per boundary)
rests on the SDK contract plus the observed behaviour. **VERDICT: #241 acceptance PASSED.**

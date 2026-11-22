# #574 fixture corpus — provenance

Frozen from the real logs on this machine (2026-11-22, ~03:00Z) by the conductor's scratch
freeze/replay scripts (they live under the conductor's scratch path, e.g.
`~/.cache/brl-subagent/scratch/spec-574/`; they are **not** part of this repository, so there is no
path in the tree to follow). Replaying this corpus with that scratch script must print
**`expectation match: 7 candidates (full schema)`**; `--selftest` in `.pi/skills/worktree/sprint-metrics.py` is the
shipped equivalent and asserts the same payload.

**Real data, real envelopes; one row is synthetic and says so.** Every real row was produced by the
extension; only fields the derivation does not need were dropped — `scrub_run` / `scrub_calls` are
explicit **allowlists** with **no free text**, so a nested `task`, `fullOutput`, `result`,
`originalParams`, `label` or `description` cannot leak by omission. Message rows keep the production
envelope (`{"type":"message","message":{"content":[{type:"toolCall",…}]}}`), so the production decoder
reads this fixture unchanged:

    python3 - <<'PY'
    import importlib.util, collections, os
    p = ".pi/skills/worktree/sprint-metrics.py"   # hyphenated filename → load by path, from the repo root
    spec = importlib.util.spec_from_file_location("sm", p)
    sm = importlib.util.module_from_spec(spec); spec.loader.exec_module(sm)
    ev = list(sm.load_events([os.path.expanduser("~/.cache/brl-subagent/scratch/spec-574/corpus/session.jsonl")],
                             "2026-11-21", "2026-11-23"))
    print(collections.Counter(k for k, _, _ in ev))
    PY
    → Counter({'run': 17, 'steer': 1, 'stop': 1, 'dispatch': 2})

| # | source | event | kind |
|---|---|---|---|
| 1 | `session-log:session.jsonl:3` | `14f143df` settled `failed/exit_error` (the `impl-554` transport death) | `failed` |
| 2 | `spawn-log:spawn.log:4` | its retry row 46 ms later — `sourceId` names the dead run, `attempt: 2` | `retry` `via:"transport"` |
| 3 | `session-log:session.jsonl:10` | `acce0602` deadline: snapshot `…06.752Z` + amendment `…06.797Z` → **one** candidate | `deadline` |
| 4 | `session-log:session.jsonl:13` | `steer_subagent` on `17c35cf1` | `steer` |
| 5 | `session-log:session.jsonl:14` | `stop_subagent` on `17c35cf1`; its effect (`failed/aborted`, line 15) is the **same** event | `stop` |
| 6 | `session-log:session.jsonl:18` | `delegate_task` with `retryRunId` → spawned `5cb04ab8` (`resumeOf`) | `retry` `via:"explicit"` |
| 7 | `session-log:session.jsonl:16` | **synthetic**: an `aborted` run with no stop call (residual R-1) | `failed` |

Line 17 is the **refused** retry call — it carries the same `retryRunId` and spawned nothing (the
capability pre-flight rejected it), so it must yield no candidate. Line 15 is the suppressed effect.
Both are traps, kept on purpose.

Every candidate carries `source` (the **physical** file and line) and `digest` — the first 16 hex of
`sha256(line bytes, UTF-8, no trailing newline)` — so a rotated or rewritten log cannot silently
re-point the evidence: the close (#533) re-reads that line and compares.

## The one synthetic row

`00000000-0000-4000-8000-000000000574` is **not real**: it pins "an `aborted` run with no
`stop_subagent` call is still a candidate". Manufacturing it for real needs a process kill outside a
probe's reach, so it is declared residual R-1 rather than hidden. It is marked `"synthetic": true` in
the row and in the expectation.

## Shape facts the reader must survive

- a run writes its `running` entry **twice**; the deadline writes its terminal entry **twice**;
- the spawn log carries **no label** — joins are by `agentId` / `sourceId`;
- the retry row's run id is `sourceId`, never `agentId`;
- a `stop` and its effect land 46–54 ms apart;
- a **refused** `delegate_task` leaves its toolCall row but spawns no run.

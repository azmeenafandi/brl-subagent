# Measurement — U2 (file-backed sessions) + U3 (recovery surface), baseline 2026-10-11

**Purpose:** gate U4 (A₂ resume) per the plan — *"sizes/debris bounded, interruptions actually observed, re-work meaningful"*. U4 stays parked until this note has evidence.

## Scope — ALL projects where the extension runs (not just the dev cockpit)

The durability stores are **cwd-scoped** (per-project), and the dev checkout is the globally active install, so every project that runs background subagents accumulates its own stores:

- `<project>/.pi/run-registry/` — U1 per-run registry entries (JSON, one per in-flight run)
- `<project>/.pi/subagents/<id>.json` — agent records (background runs)
- `<project>/.pi/subagents/sessions/<id>/` — **U2** per-run session dirs (live during a run; pruned at terminal settle; kept when interrupted)

**Enumeration command (run for each snapshot):**
```bash
find /home/azmeen/public_projects -maxdepth 4 -type d -name "run-registry" -o -maxdepth 4 -type d -path "*/.pi/subagents" 2>/dev/null \
| while read d; do proj=$(echo "$d" | sed 's#/.pi/.*##');
    echo "$proj | registry: $(ls "$proj/.pi/run-registry" 2>/dev/null | wc -l) files/$(du -sh "$proj/.pi/run-registry" 2>/dev/null | cut -f1) | sessions: $(ls "$proj/.pi/subagents/sessions" 2>/dev/null | wc -l) dirs/$(du -sh "$proj/.pi/subagents/sessions" 2>/dev/null | cut -f1) | records: $(ls "$proj/.pi/subagents"/*.json 2>/dev/null | wc -l)";
  done
```
Interruption evidence = registry entries carrying `interruptedAt`, agent records with `interruptedAt`, or a boot-recovery notice observed in a live session.

## Baseline — 2026-10-11 (window start; U2+U3 activated this day)

| Project | Records | Registry | Session dirs | Interruptions observed |
|---|---|---|---|---|
| `brl-subagent-dev` | 0 (empty) | 0 | 0 (absent) | 0 |
| `spelling_bee` | 8 (newest Aug 21; all terminal) | 0 | 0 | 0 |
| `deep-research-agent` | 3 (newest Sep 13; all terminal) | 0 | 0 | 0 |
| `ephemeral-rp` | 11 (newest Oct 8; all terminal) | 0 | 0 | 0 |

**Footprint: effectively zero.** No project has ever left an interrupted/running record; no store exceeds a few KB. U2 session dirs start accumulating from the first background run after each project's next pi session (the dev install is global; new processes pick it up).

## Procedure

- **Baseline:** captured above.
- **Rolling:** append a snapshot after each observed interruption AND at least weekly (next due ~2026-10-18), same enumeration command.
- **Extension policy (2026-10-14):** if a snapshot still reads zero interruptions across all projects, EXTEND the window rather than conclude (zero observed = insufficient exposure); record the new due date here.
- **Assess per interruption:** would resume have avoided meaningful re-work? (task size, how far the run got, whether a cold re-dispatch repeated it). Record the judgment — this is the "re-work meaningful" criterion.
- **Debris check:** session dirs left behind by terminal/abandoned runs (should be none; U2 prunes), registry entries for settled runs (should be retired).

## Gate status

| Criterion | Status |
|---|---|
| Sizes/debris bounded | Baseline zero; curve starts now (trivially bounded so far). |
| Interruptions actually observed | **0** — the decisive criterion; needs real events. |
| Re-work meaningful | **No data** — nothing to assess yet. |

**U4 dispatch remains parked until at least one real interruption (or a recorded maintainer decision to waive).**

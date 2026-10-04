# Sprint-end ritual (Rule 11 + trust metrics)

**Trigger: a SPRINT boundary — never a worktree event.** A sprint spans many
worktree create/teardown cycles; closing one worktree is not a sprint end.
Do NOT run this at worktree cleanup — run it when the sprint's work is done.

**A sprint ends when the user declares it.** There is no time-based or
release-based cadence: the human maintainer calls the boundary — the machine
does not tire, the human does. Do not infer a sprint end from a release, a
merged PR, or a worktree teardown; wait to be told.

At sprint end, BOTH of these run — they share one cadence:

1. **Recurrence escalation (Rule 11):** group the sprint's friction entries by
   CLASS (not tag), count occurrences. Any class with ≥2 occurrences AND not
   resolved → P0 for next sprint, filed as an issue with a fix direction.
   Recurrence evidence overrides a "mitigated" label.
2. **Trust metrics:** run `python3 .pi/skills/worktree/sprint-metrics.py
   --since <sprint-start> --until <sprint-end> --sprint <label> --out
   .development/METRICS.md` — the script derives the rates from the session
   log (never vibed), appends the row, and the numbers feed the Rule 11
   escalation mechanically. Review the row alongside the friction log:
   the log answers WHY, the metrics answer HOW MANY.

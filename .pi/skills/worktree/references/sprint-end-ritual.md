# Cycle-end ritual (Rule 11 + trust metrics + environment sweep)

> Historically the **"sprint-end ritual"**. The operative term is now **cycle**: a cycle is the
> work between releases. File and flag names (`sprint-end-ritual.md`, `sprint-metrics.py`,
> `--sprint`, the "Sprint" column) keep the historical name — read every "sprint" as "cycle".
> Part 3 (environment sweep) is adapted from `mattpocock/skills` — `engineering/retro`
> (MIT © 2026 Matt Pocock).

**Trigger: a CYCLE boundary — never a worktree event.**

A cycle **opens** when the conductor records one line in the HANDOFF STATE block —
`Cycle: <theme>` — usually right after a release, or when a direction is agreed. It **closes**
when the maintainer declares it: normally at release planning ("does this release close the
cycle?"), with this ritual executed **BEFORE the release ritual** (its outputs — the metrics row,
the board state, the candidates — feed the release docs and the next cycle's opening); or, for a
release-less arc running longer than ~3 weeks, at the maintainer's call.

**The machine does not tire, the human does.** Do not infer a cycle end from a release, a merged
PR, or a worktree teardown; wait to be told.

At cycle end, ALL FOUR run — they share one cadence:

1. **Recurrence escalation (Rule 11):** group the cycle's friction entries by CLASS (not tag),
   count occurrences. Any class with ≥2 occurrences AND not resolved → P0 for the next cycle,
   filed as an issue with a fix direction. Recurrence evidence overrides a "mitigated" label.
   **Every escalation carries `fix: mechanical | judgement` — default to mechanical** (build a
   check/ratchet/test; reserve judgement docs for what no guardrail could catch).
2. **Trust metrics:** run `python3 .pi/skills/worktree/sprint-metrics.py --since <cycle-start>
   --until <declaration-instant> --sprint <label> --out .development/METRICS.md` — the script
   derives the rates from the session log (never vibed), appends the row, and the numbers feed
   the Rule 11 escalation mechanically. Windows are **true timestamps** (a time-suffixed bound
   filters to the instant; naive bounds are read as UTC), so the window can end exactly at the
   declaration. Review the row alongside the friction log: the log answers WHY, the metrics
   answer HOW MANY.

   **Count reconciliation is mechanical now (U4, #489).** The tool counts direct
   `delegate_task` calls **and** codemode-routed ones, then reconciles the dispatch count
   against the extension log's spawn starts over the SAME window. Run it from the cockpit
   (the dev checkout): the spawn log lives where the extension runs, so a worktree lacks it
   and the output says `reconcile unavailable ... the dispatch count is a session-log floor`.

   ```text
   dispatches: N (direct A + codemode B) · spawns: M · Δ D
   spawn source: <path> (found|NOT FOUND) — <starts, retries>
   allowance: <retry starts + fan-out units beyond the first>
   ```

   - `Δ` within the printed **allowance** is reconciled: fan-out and transport auto-retries
     legitimately produce more spawns than dispatches, and the allowance is derived per
     window, not guessed.
   - `Δ` outside the allowance exits **3**, prints `RECONCILE FAILED`, and **does not append
     the row** — fix the count first, do not hand-edit the table.
   - `reconcile unavailable` is floor-only: the window is not reconciled, so say so in the
     handoff rather than trusting the number.
   - A codemode `tasks:` fan-out is not statically parseable; it surfaces as a loud
     under-count (the safe direction) rather than a silent pass.

   The #336 incident (a time-suffixed bound counted 22 dispatches against 68 logged spawns)
   is now a loud failure, not a judgment call. The parser is itself guarded: run
   `python3 .pi/skills/worktree/sprint-metrics.py --selftest` (wired into CI).
3. **Environment sweep (bounded, advisory):** walk the cycle's record once against these
   categories — (1) **Navigation** (did finding files cost time? hidden dependencies?) ·
   (2) **Automated checks** (any guardrail missing, unwired, or silently broken — *"a check that
   exists but does not run is the finding"*) · (3) **Coding standards** (mechanical violations →
   checks; judgement calls → reviewer rules) · (4) **Steering/no-ops** (instructions that no
   longer change behavior) · (5) **Tool economy** (expensive or token-inefficient calls) ·
   (6) **Information access** (missing logs, missing read-only access) · (7) **AGENTS.md
   hygiene** (steering text that belongs in a check or a reference). Budget: minutes, not an
   essay — cap ~5 candidates, each tagged `fix: mechanical | judgement`, presented by severity.
4. **Retro candidates (advisory, below the threshold):** one-off findings that did not meet
   Rule 11's ≥2 bar but are worth a look — severity-ordered, explicitly non-binding (accept →
   normal backlog item; reject → recorded once and dropped). This exists because the ≥2 floor is
   truthful but blind to good single-shot fixes.

**The close row (contract, part of the same ritual).** The cycle's closing record row — the
friction-log entry that states the cycle is closed, written beside the metrics row — ends with the
release line in this exact shape:

```
release: the maintainer's call
```

**Never a version.** Even when every input points at one, the row names no number, no "release
proposal", and no "awaiting the go for vX.Y.Z" — naming a version is the first step of an
unprompted release (Conductor decision rule 1, `SKILL.md`). The maintainer proposes or approves a
version in their own turn; the release ritual then records it. A row that carries a proposed version
is a process defect, not a wording nit.

**Post-close findings:** a defect surfaced by the release that implicates the closed cycle's work
(e.g., the published artifact differs from the tag) is recorded against the CLOSED cycle as a
"post-close finding" — even though the release ceremony itself belongs to the next cycle.

# Friction log ritual

Log a friction **when one occurs** — not once per cycle. A clean delegation
cycle logs **nothing**, and that is the expected outcome. Append one line to
`.development/FRICTION_LOG.md`:

```
YYYY-MM-DD | <tag> | <observation>
```

One line, no elaboration, no judgment — what happened, not what to do about it.
Log frictions as they happen, not deferred to sprint end. The purpose is the
tripwire against losing *genuine* workflow observations to the dopamine of
merged PRs — signal, not ceremony.

**What counts:** anything that took an unexpected path — *or could have*. A
near-miss qualifies (a wrong course proposed and caught before it shipped), not
just a realised failure. **This is not a blame log**: it records paths, not
people — no finger-pointing at the assistant, the conductor, or the user,
because a log that assigns fault stops being written in honestly. Its purpose
is **enlightenment** — what can we improve in how we develop, useful for
brl-subagent and portable to other projects.

**Never manufacture an entry to satisfy the ritual.** A forced or padded entry
is worse than silence: the log feeds the Rule 11 class counts (≥2 occurrences →
P0), so an invented friction can fabricate a recurrence and produce a false
priority. An empty log over a clean cycle is a correct log.

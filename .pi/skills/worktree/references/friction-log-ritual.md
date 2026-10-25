# Friction log ritual

Log a friction **when one occurs** — not once per cycle. A clean delegation
cycle logs **nothing**, and that is the expected outcome. Append one row to the
table in `.development/FRICTION_LOG.md` (one shape — never mix lists and
tables):

```
| YYYY-MM-DD | <tag> | <observation> |
```

Escape a literal `|` inside the observation as `\|` (GFM splits cells on it).

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

**Count by key, not prose.** When the friction is a smell, open the observation
with its smell key (`duplicated-code`, `oversized-function`,
`too-many-parameters`, `deep-nesting`, `oversized-file` — the vocabulary in
`references/review-dispatch.md`):

```
| 2026-10-25 | implement | `duplicated-code`: the completion prose re-landed in a second surface |
```

Then Rule 11's ≥2-occurrence count is a `grep` on a key rather than a re-read of
every row's prose — the class is the same whether it arrived via review, the
prose guard, or a delegation failure, and past cycles' rows become countable
after the fact.

# Adversarial review dispatch (how-to)

Classify first — the C1/C2/C3 table is in `SKILL.md`.

Reviewers are **read-only on the repo but have bash** — the read-only
`code-reviewer` preset excludes bash and is NOT used (empirical verification
needs execution). Use the project-scoped `project-reviewer` preset
(`.pi/brl-subagent/presets/project-reviewer.md`): tools `read, bash, grep,
find, ls`, explicitly NO `write`/`edit` so the reviewer can never touch code.
It carries the Gate A expectation, the SOLID/DRY mirror check, and the
verdict format — the dispatch task only adds the PR-specific focus areas.

**Dispatch with `preset: "project-reviewer"` — NOT bare `tools` (the
auto-route can override an explicit tools list; an explicit preset wins) and
NOT `dev-agent` + `excludeTools` (the retired workaround).**

**The instruction MUST demand the verdict in the final output** — never tell
the reviewer to write a file it cannot write:

- Do NOT write any files.
- Output your verdict in this exact format in your final response:
  verdict line (`approve` / `approve-with-nits` / `changes-requested`),
  findings table (severity | file:line | one-liner), verified-OK list,
  and `SOLID/DRY violations flagged: N` (the efficacy gauge — the
  project-reviewer preset's mirror check feeds it).
- Gate A: verify stateful claims (teardown, races, git/fs behavior)
  empirically — scratch repos in /tmp, real commands — do not just read code.
- Keep the verdict compact; the deep write-up lives in the final output only.

The conductor retrieves the final output (never sleep-waits — the user
watches the monitor and pings when done), writes `REVIEW_PR*.md` in the
worktree from the returned verdict, and presents it for the user loop.

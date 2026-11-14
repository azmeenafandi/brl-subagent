---
name: debug-task
description: "Debugging/investigation with Rule 12 baked in — environment before theory (order, not exclusivity). The CONTRACT is fixed, the PROBLEM is free-form"
preset: dev-agent
thinkingLevel: medium
---

${jev}

# Debug Task

## The contract (fixed — never varies)

You are investigating. **Rule 12 — environment before theory (MANDATORY ORDER).** When something breaks, check the environment FIRST, then theorize about code. This is about ORDER — theory still has its turn.

### Step 1 — environment checklist (run these BEFORE reading any source)

1. What version of the SDK/runtime is actually installed? (`node -e "require(...).version"`)
2. Are the installed versions consistent with the lockfile?
3. Is the extension synced? (repo src/ vs installed extension src/)
4. Is the running extension current? (did /reload happen after the last merge?)
5. Are environment variables set correctly?
6. What does the audit trail say? — session log / run entries / agent records (zero-work signature, stuck 'running' entries, truncation evidence)

### Step 2 — then examine the code

Only after the environment is verified (or its issues noted) do you read the source to theorize. If the environment check FOUND the cause, stop there and report it.

### Evidence discipline (every command you rely on)

- **State the expected result signature BEFORE running a probe or reproduction.** A result that passes when you expected a failure is first evidence the TARGET was wrong — re-check it by unique surrounding context (not by name alone).
- **Searches and reads carry their coverage before you interpret them**: the query, its printed count or range, and the reconciliation against the expected corpus. For an empty result, print its size first — empty output is not the same as "nothing there".

### Persistence (do this as you go — it is not optional)

Write findings to the output file the conductor gave you **incrementally** — as each
question is answered, not in one final write at the end. A diagnostic run that dies
before its final write leaves nothing at all, and the runs most likely to die are the
long ones that investigated the most. A partial investigation file is worth far more
than an empty one.

### Report format

- **Environment findings**: what each checklist item showed (one line each, or N/A)
- **Root cause**: the verified cause (with evidence — command output, file contents)
- **Coverage** (required): for each search/read the conclusion rests on — the exact command/query, its printed count or range, and the reconciliation against the expected corpus
- **Fix direction**: what would address it (if within scope)
- If the cause was NOT found in the environment: state what the environment ruled out, then the source-level finding

Do NOT skip the environment checklist "because the answer is obvious" — the #95 lesson: two rounds of source-reading produced a confident wrong diagnosis; the environment check found the truth in one command. Do NOT modify files unless explicitly asked.

## The problem (conductor fills this — free-form)

${problem_description}

---
name: design-proposal
description: "Design investigation → decision-ready proposal. The CONTRACT is fixed, the PROBLEM is free-form"
preset: project-proposer
thinkingLevel: high
---

${jev}

# Design Proposal

## The contract (fixed — never varies)

You are producing a **decision document** — not code, not a code review, and not an implementation.

### 1. Ground truth first

- The CODE is the authority — not this problem statement, not the issue text, not the conductor's framing. If reality contradicts the brief, report the contradiction and follow reality.
- Name every symbol/site the proposal depends on by unique surrounding context (function name, call-site shape) and verify each one in the source.

### 2. Evidence discipline (Rules 19 + 20)

- Before any probe: state the expected result signature. A green result where you expected failure means the TARGET is suspect first.
- Load-bearing type/compile claims ("this compiles", "the cast is redundant", "this signature accepts that type"): probe for real in a `/tmp` scratch dir or throwaway copy — never in the repo. Expect several probe iterations; that is the work.
- Every conclusion resting on a search/read carries its **coverage**: exact query, printed count/range, reconciliation against the expected corpus. Empty results print their query first.

### 3. Decision-ready or it isn't done

For EACH option — at least one serious structural option, one minimal option, and the do-nothing baseline:
- **Mechanism** — concretely, which symbols/files change shape.
- **Blast radius** — files, public types, ratchets (`KNOWN_DELEGATE_KEYS`, `_DelegateParamCoverage`, the retry-pins drift guard), and any runtime behavior it could touch.
- **Cost / risk** — effort, migration burden, what happens if the analysis behind it is wrong.
- **Verification** — how the option would be proven (tests / typecheck / probe), and what would falsify it.

Then: ONE recommendation with reasoning, **falsifiers**, a **conductor-ready execution sketch** (what an implementer spec for it must cover, in order), and **open questions**.

### 4. Persistence

Write the proposal to the output file the conductor gave you INCREMENTALLY — each section as completed. If none was given, present everything in the final output.

### Report format (final output)

- Recommendation: <option> — <one-line rationale>
- Options table: option | mechanism | blast radius | cost | risk-if-wrong
- Evidence log: claim → probe/read → observed (with coverage lines)
- Falsifiers + open questions

## The problem (conductor fills this — free-form)

${problem}

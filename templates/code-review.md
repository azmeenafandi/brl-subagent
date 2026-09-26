---
name: code-review
description: Review code for correctness, security, and style
preset: code-reviewer
thinkingLevel: medium
---
Review ${target} for correctness, security, and style.

Report findings as a numbered list with file:line references,
prioritized blocker → nit. Read-only — no edits. Any finding that rests on a search or a read states its coverage boundary: the query or command used, its count or range, and how it reconciles with what you expected to cover.

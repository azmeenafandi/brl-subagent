# Serena bake-off — findings

- **Date:** 2026-11-05
- **Candidate:** Serena 2.1.0 (LSP-backed MCP code intelligence, GPL-3.0)
- **Issue:** #427
- **Verdict:** **park** — the gaps are real, but every adoption path creates a second
  "what references this?" lane, which is exactly the ambiguity ADR 0016 closed.
- **Teardown:** scratch copy removed; `uv tool uninstall serena-agent` (GPL dev tool, not kept).

## Setup cost (measured)

| step | time | note |
|---|---|---|
| `uv python install 3.13` | 2 s | managed download |
| `uv tool install -p 3.13 serena-agent` | 3 s | Serena 2.1.0 + deps |
| `serena project create --ls typescript --ls bash --index` | 11 s | 181 files: TS 172, bash 9; language servers downloaded on demand |
| per tool call (fresh server + LSP per invocation) | 5–6 s | our harness starts a server per call; a persistent server would amortize the first ~5 s |
| **v2 default interface** | — | **REPL**: only 3 MCP tools (`activate_project`, `initial_instructions`, `serena_repl`); classic tools require `--agent-interface tools` |

## Answers vs ground truth

| # | Question | CodeGraph | Serena | Winner |
|---|---|---|---|---|
| Q3 | `SessionState` in **type positions** | `callers` finds the test-factory constant only; type refs invisible | 6 s, full reference list incl. `import type`, `Pick<SessionState,…>`, parameters, each with context lines | **Serena, decisively** |
| Q4 | Rename impact of `formatBudgetDuration` | 4 callers (test + `formatBudget` + …), no import edges | 6 s, import in `notify-completion.ts` + every call site with context | tie on fact, Serena richer (and more token-heavy) |
| Q5 | What implements `Logger`? | not answerable (`callers` ≠ implementations) | `find_implementations` → `createLogger` (5 s) | **Serena** |
| Q1/Q7 | Bash symbols / refs in `merge-guard.sh` | **no results** (bash not indexed) | symbol overview (127 vars, 25 funcs) and `find_referencing_symbols("fail_line")` → `check_ci`, `check_recheck` (6 s) | **Serena** (intra-script); cross-file `bash script.sh` invocations remain text for both |
| Q2 | Symbols in `jev-check.mjs` | finds `formatDispatchLine` | overview: 36 functions / 24 constants | tie |
| Q8 | Markdown mention (negative control) | — | text search only (same as grep) | no semantic win |

Mutation-style honesty check: Serena's answers were verified against `grep`/`read` in the cockpit,
not accepted on trust; the bash reference list matched the script's callers exactly.

## What this proves

- **Real gaps:** type-position references, implementations, and bash symbols are things CodeGraph
  structurally cannot see. Recent work would have benefited once (the `Structural closure` block
  counts callers, not type references).
- **Real costs:** a second "what references X?" tool; 5–6 s per query (vs CodeGraph's sub-second);
  GPL-3.0 (dev-only at best); Python + per-language servers; a v2 REPL default that changes the
  integration shape; no CI story; MCP exposure to spawned children unresolved (a blocker: whether
  project MCP tools bypass a preset's read-only allowlist is unknown).

## Decision against the stated criteria

| Criterion | Result |
|---|---|
| ≥2 questions answered correctly where CodeGraph fails | **pass** (Q3, Q5, Q1/Q7) |
| Setup ≤15 min, non-interactive | **pass** (~16 s, with explicit `--ls`) |
| No shipped/CI dependency | **pass** (dev-only, GPL noted) |
| One-sentence routing rule with **no overlap** | **fail** — "CodeGraph for calls, Serena for type/implementation references and bash" still leaves two answers to "what references this?", the exact ambiguity ADR 0016 exists to prevent |

Three of four pass; the fourth is the one that matters. **Park.**

## What to do instead (if the gap bites)

1. **Type references at refactor time:** `grep -n "<symbol>"` + read the hits is adequate and was
   how ground truth was produced here; a `tsc`-based helper is a cheaper future option than a second
   index.
2. **Bash symbols:** `grep -nE '^(function )?[a-zA-Z_]+\(\)'` gives the function list; the shell
   layer is small (9 files) and text-level by nature.
3. **Implementations:** `grep -n "implements Logger"` / object literals; structural typing makes an
   LSP answer fuzzy anyway.
4. **Steal the idea** — symbol-level editing/refactoring is a better interface than text replacement
   — but that is a CodeGraph/harness upgrade question, not an adoption.

## Reopen trigger

Reopen only if: (a) CodeGraph adds no type/reference capability and a refactor PR's `Structural
closure` misses a type-only reference in a way that matters, **or** (b) a second MCP-based tool
becomes necessary for another reason, making the lane split free rather than a new cost.

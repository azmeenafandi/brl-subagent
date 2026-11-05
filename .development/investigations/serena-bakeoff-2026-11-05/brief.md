# Serena bake-off — does LSP add anything CodeGraph cannot?

- **Date:** 2026-11-05
- **Status:** brief — not run yet
- **Candidate:** https://github.com/oraios/serena (LSP-backed MCP code-intelligence server)
- **Issue:** filed with this brief
- **Prior art:** `.development/investigations/codegraph-bakeoff-2026-10-08/findings.md` (ADR 0015 Phase 0)

## The question

Does Serena answer **real questions our current stack answers wrongly or not at all**, well enough
to justify a second structural system in the workflow? Not "is it good" — it plainly is. The bar
is narrow: **CodeGraph's blind spots**, measured against ground truth.

## Verified facts (2026-11-05, not from memory)

- Serena is an **MCP server** over **LSP**; 40+ languages incl. **TypeScript, JavaScript, Bash**
  (`README`, language list); symbol-level retrieval/editing/refactoring; a memory system; v2 adds a
  REPL interface; Python; **GPL-3.0-or-later**; ~31 k stars; active.
- pi supports project-local MCP (`.pi/mcp.json`, read after project trust; `/reload` after edits).
- Our package is **MIT**. `.pi/*` is gitignored, so a project-local server config is not shipped.
- **ADR 0016:** CodeGraph is the *sole structural index*.
- **ADR 0015:** conductor-side, CLI-only, pinned, watcher off, no hooks.
- Known CodeGraph gap: **shell scripts are not indexed** (`codegraph query recon.sh` → no
  results), so `merge-guard.sh`, `recon.sh`, `codegraph-refresh.sh` are invisible to the graph.
- Tooling files are TS/MJS (`.pi/extensions/**`, `scripts/*.mjs`) but the shell layer is not.

## Candidate questions (ground truth is checkable without Serena)

| # | Question | Why CodeGraph struggles | Ground truth |
|---|---|---|---|
| Q1 | Which scripts invoke `merge-guard.sh` / `recon.sh`? | bash not indexed | `grep -rn` |
| Q2 | Where is `jev-check.mjs` invoked, under which labels? | `.mjs` may be unindexed (verify) | `grep -rn`, provenance log |
| Q3 | Which modules use `SessionState` in **type positions** (not calls)? | call graph sees calls, not type refs | `grep -n "SessionState"`, tsc |
| Q4 | Rename impact for `formatBudgetDuration` (imports + calls) | `impact` is file/symbol-call oriented | `grep -rn`, tsc |
| Q5 | What implements the `Logger` interface? | `callers` does not answer implementations | `grep -rn "Logger"` |
| Q6 | Which exported symbols in `src/` have **no** references? | `impact` may miss type-only/zero-caller cases | `grep`, tsc, codegraph impact |
| Q7 | What does `worktree-cleanup.sh` call, transitively? | bash not indexed | read the script |
| Q8 | (negative control) Which markdown docs reference `liveDisplayEntries`? | neither indexes prose | `grep` |

Q8 exists to catch over-claiming: if Serena "answers" it, the answer is suspect.

## Method

1. **Scratch copy** (never the cockpit): `git archive HEAD | tar -x -C /tmp/serena-bakeoff/repo`.
2. **Install** `uv tool install -p 3.13 serena-agent`; record install time and disk.
3. **Project setup** in the scratch dir; run `serena project index`; record index time and any
   language-server downloads.
4. **Drive the tools** through a minimal MCP stdio client (Python `mcp` SDK via `uv run`) — not
   through pi, so the measurement is of Serena's answers, not of our MCP wiring. A pi-side
   integration check is a *separate* follow-up, only if the answers justify it.
5. **Ground truth** each answer with `grep`/`read`/`tsc` in the cockpit; score correct / partial /
   wrong, and record the output size (tokens) and latency.
6. **Teardown**: delete the scratch dir and the tool install; no repo changes.

## Metrics

- setup wall time, index wall time, disk;
- per-question latency and output size;
- **correctness vs ground truth** (the only metric that decides);
- failure modes (language server missing, index gaps, network at query time);
- reproducibility: could this run in CI? (expected: no — that is a cost, not a surprise).

## Decision criteria (falsifiable)

**Adopt (conductor-side, project-local)** only if **all** hold:

1. it answers **≥2** of Q1–Q7 **correctly** where CodeGraph fails or is materially worse;
2. setup is reproducible in **≤15 minutes** from a clean machine, with no interactive steps;
3. no shipped dependency and no CI requirement (dev-only, GPL noted);
4. a routing rule can be stated in one sentence that does not overlap CodeGraph's lane.

Otherwise: **park**, and record which CodeGraph gap (if any) remains worth closing another way
(e.g. a shell-aware query helper, or grep as the documented text-level exception).

## Non-goals

- No adoption in this investigation; no change to `.pi/mcp.json` in the cockpit.
- Not evaluating Serena's memory system as a handoff replacement (a competing source of truth is
  disqualified by design).
- Not evaluating the JetBrains plugin.

## Risks / open questions

- **MCP exposure to children.** A project-level server is visible to spawned pi children; whether
  its tools bypass a preset's read-only `tools` allowlist is unknown and must be checked *before*
  any adoption. This is a blocker for reviewer presets, not for the bake-off (which runs in a
  scratch dir).
- GPL-3.0: dev-only use is fine; a shipped dependency is not. Any doc recommending it needs a note.
- Language-server downloads and per-language configuration are the likely time sink; that cost is
  part of the measurement.

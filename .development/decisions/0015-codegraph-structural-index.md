# 0015. Two knowledge layers: CodeGraph for structure, graphify for semantics

- **Status:** Accepted
- **Date:** 2026-10-10
- **Issues:** #230

## Context

The cockpit's knowledge graph is refreshed at every merge into `dev` (`graph-refresh.sh`), and graphify's
extraction is LLM-based. Over the monitoring window the shrink guard refused **7 refreshes — every one a
docs-semantic variance, 0 involving `src/` structure**. The last two days alone needed **both force flags**
(`--allow-partial` + `--allow-dedup-shrink`) on docs-only merges, and one forced run **silently no-op'd** (the
second refusal line was cut by `tail`, so the post-run `graph-check.py` passed against the old file — only the
unchanged `graph.json` mtime caught it). These are the friction log's `graphify-completeness-guard-refusals`
entries, and the class is now an upstream issue (`graphify#3580`).

Phase 0's bake-off (`.development/investigations/codegraph-bakeoff-2026-10-08/findings.md`) tested CodeGraph
1.6.2 as the structural alternative and **PASSED every bar item**:

- **Coverage** — 34/34 modules and 0 missing of 322 exported declarations, in **5 ms**, from SQLite alone.
- **Query parity** — all real question sets correct, including the re-export seam (`getTranscriptPath`) that
  confused graphify, resolved in both directions; `callers` returns semantic references (the enclosing
  function, or the file node for a callback), not raw grep hits.
- **Determinism** — a re-index is byte-identical and a docs-only sync is a **no-op** (CodeGraph indexes no
  markdown at all), so refusals #1–#7 cannot occur; explicit `sync` fits #230 (no daemon, no watcher).
- **Freshness is declared** — `project_metadata.indexed_at_commit == HEAD`, strictly stronger than
  `graph-check.py`'s mtime comparison.

Usage reality decided the split: the conductor's real Rule 13 work is **structural** — callers, impact, blast
radius, affected tests. Doc-concept and community queries are the rarer, on-demand case.

## Decision

- **CodeGraph is the merge-gated structural index.** Refreshed by an explicit `codegraph sync` (or a full
  `codegraph index`) at each merge, run **CLI-only, conductor-side**; the watcher/daemon stays off; **never a
  hook** (#230). Its guard is `codegraph-check.py`: module + exported-symbol coverage plus
  `indexed_at_commit == HEAD` and `index_state = complete`.
- **graphify stays the on-demand semantic/doc layer.** It answers concept, community, and cross-document
  questions; after Phase 2 it carries **no merge gate** and is refreshed only when a semantic query needs it.
- **Routing:** structural questions → CodeGraph (`callers`, `impact`, `query`, `affected`); concepts and docs →
  graphify.
- **This ADR changes nothing about the current gate.** Until the Phase 2 criteria below are met, the merge
  ritual still runs `graph-refresh.sh`; the CodeGraph pair is a documented, manual tool.

## Consequences

- The refusal class leaves the merge gate: docs-only merges can no longer trip a semantic shrink guard, need
  manual two-flag reconciliation, or no-op silently. Structural freshness becomes a single declared-commit
  assertion.
- **Owed before trust transfers:** broader unresolved-ref sampling (14,344 unresolved refs, 12,223 of them
  `calls`; 1,989 unresolved calls in `src/` non-test) — Phase 0 sampled only three symbols; and a supply-chain
  posture review of a **62 MB single-maintainer native binary** (per-platform release assets). Neither is
  assessed.
- **Doc semantics leave the gate.** A knowledge graph that is only structural gives up automatic doc-graph
  regeneration on merge; graphify's doc nodes go stale between on-demand refreshes.
- **Preserved:** `graphify-out/` and doc-concept queries remain available, and the generated docs guards
  (`docs-arch`, `docs-decisions`) are untouched.
- The new dependency is a pinned, `DO_NOT_TRACK=1`, gitignored CLI (`.codegraph/`); a deliberate bump is
  `pnpm add -g @colbymchenry/codegraph@<v>` → full `codegraph index` → refresh green.

## Phase 2 entry criteria (the formal window; an initial one-off trial ran 2026-10-08)

Phase 2 is the dogfood window that decides retirement/narrowing. It begins at the first post-dependabot merge
and runs both refreshes **side by side**:

1. **Run both refreshes** — `graph-refresh.sh` (still the gate) and `codegraph-refresh.sh` (shadowing it) at
   each merge into `dev`.
2. **Measure** — graphify refusal rate (expect 0 for the structural layer), CodeGraph sync wall time, and query
   parity on **5–10 real questions** (not three symbols).
3. **Decide** — retire or narrow graphify after **a week or N merges, whichever comes first**, on that evidence;
   cockpit `.codegraph/` is already present from the 2026-10-08 trial (11 MB, gitignored) — what Phase 2 decides is the per-merge usage, not adoption.
4. **Feed the decision** — unresolved-ref sampling and the binary's supply-chain posture are Phase 2 inputs.

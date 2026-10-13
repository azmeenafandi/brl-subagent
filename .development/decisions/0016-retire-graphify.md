# 0016. Retire graphify: CodeGraph is the sole structural index

- **Status:** Accepted
- **Date:** 2026-10-10
- **Issues:** #313, #314
- **Amends:** ADR 0015 — its two-layer split and Phase 2 criteria are superseded (graphify is retired, not narrowed)

## Context

ADR 0015 split the cockpit's knowledge layers: CodeGraph as the merge-gated structural index, graphify as the
on-demand semantic/doc layer. The split rested on a usage assumption — that concept, community, and
cross-document questions were the "rarer, on-demand case" and worth keeping a second tool for. The operational
arc did not bear that out. **The semantic layer had no recorded query usage**: no dispatch, spec, or scoping
pass ever consulted `graphify-out/` for a concept or community answer, while the structural questions Rule 13
actually asks (callers, impact, affected tests) were answered by CodeGraph or by grep.

What the semantic layer *did* produce was maintenance:

- **The refusal class (#313).** Over the monitoring window the LLM-extraction shrink guard refused **9
  refreshes** — every one a docs-semantic variance, **0 involving `src/` structure**. Each refusal required
  manual attribution and force flags (`--allow-partial`, `--allow-dedup-shrink`), and twice the single-flag
  force silently no-op'd, caught only by an unchanged `graph.json` mtime. A docs-only lockfile merge could
  refuse while a code merge passed: the trigger was extraction variance, not input class.
- **The hook class (#314).** The post-commit hook fired on **both** release bumps — v2.4.0 (2026-10-03) and
  v2.5.0 (2026-10-10) — each time launching an incomplete rebuild inside the **pristine `main`** checkout,
  removed manually each time. This is the persistent #230 class: the guard catches bad graphs but is not on
  the hook's path.

ADR 0015's Phase 2 window had opened (two data points: the lockfile merge refusing in 149 s while the CodeGraph
shadow passed in 5 s with `indexed_at_commit == HEAD`; the code merge passing both). The maintainer considered
the ADR's retire-or-narrow criteria and **declined the dogfood in favour of retiring graphify outright** — the
measurement would only have priced a layer nothing queried.

## Decision

- **graphify is retired.** No merge gate, no hook, no generated artifact, no `.gitattributes` merge driver, no
  CLI on the machine.
- **CodeGraph is the SOLE structural index.** Refreshed by `codegraph-refresh.sh` (explicit `codegraph sync` +
  `codegraph-check.py`) at every merge into `dev` — explicit invocation, CLI-only, conductor-side, **never a
  hook** (#230 discipline). Its declared-commit freshness assertion (`indexed_at_commit == HEAD`) replaces the
  mtime comparison that produced false STALE readings.
- **Doc navigation falls back to grep + `docs-arch` + the ADRs.** Concept and community questions are answered
  deterministically: grep over `.development/`, the generated docs (`docs-arch`, `docs-decisions`), and the ADR
  series. No LLM sits on that path.
- **ADR 0015's Phase 2 criteria are superseded and moot.** The retirement replaces the week-or-N-merges
  measurement; the Phase 2 dogfood log closes with a RETIRED note.
- **Removed with the tool:** `graph-refresh.sh`, `graph-check.py`, the `post-commit`/`post-checkout` hooks, the
  graph.json merge driver, `~/.graphify`, and the 41 MB `graphify-out/` tree (its final report archived).

## Consequences

- **Given up:** automatic doc-concept, community, and cross-document queries. Doc semantics leave the merge
  gate entirely; the final graph report is a static archive, not a live index.
- **Gained:** the merge gate loses its only LLM-in-the-loop step. Docs-only and lockfile-only merges can no
  longer refuse, need manual two-flag reconciliation, or no-op silently — the cost that produced #313 and #314
  disappears with the tool.
- **The structural split survives.** ADR 0015's core — CodeGraph answers the Rule 13 scoping questions
  (`callers`, `impact`, `query`, `affected`) — is confirmed and now holds alone.
- **Reversibility:** graphify is an external tool with no repo-resident state. Reinstall + `graphify hook
  install` restores the old posture; the archived report and the friction log preserve what it answered.
- The generated docs guards (`docs-arch`, `docs-decisions`) are untouched.

## Evidence

- Archived final report: `.development/investigations/graphify-retirement-2026-10-10/` (`README.md`,
  `GRAPH_REPORT.md`).
- Phase 2 dogfood log (data points #1–#2, then RETIRED): `.development/investigations/codegraph-phase2-dogfood-2026-10-10.md`.
- Phase 0 bake-off bar (CodeGraph's coverage/parity/determinism evidence): `.development/investigations/codegraph-bakeoff-2026-10-08/findings.md`.
- Friction: `graphify-completeness-guard-refusals` (recurrences 1–8) and `graph-hook-writes-into-main` (×2).
- Issues: #313 (refusal class), #314 (hook rebuilding inside `main`).

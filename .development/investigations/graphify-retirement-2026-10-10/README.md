# Graphify retirement (2026-10-10)

Executed on the maintainer's decision: graphify is retired — **CodeGraph is the sole
structural index** (ADR 0016).

- `GRAPH_REPORT.md` — the final human-readable graph report (archived before deletion).
- Removed: the `post-commit`/`post-checkout` hooks + the graph.json merge driver (`.gitattributes`),
  the CLI (`graphify 0.9.80`, uv tool `graphifyy`), `~/.graphify`, and the 41 MB `graphify-out/` tree.
- Why: the semantic layer had no recorded query usage across the arc, while its refusal class
  (#313) and hook class (#314) cost real maintenance; both issues close with this retirement.
- Re-adoption is possible at any time (external tool): reinstall + `graphify hook install`.

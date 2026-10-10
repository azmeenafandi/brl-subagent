#!/usr/bin/env python3
"""graph-check.py — verify the knowledge graph against ground truth (issues #173, #189).

WHY THIS EXISTS
The release ritual refreshes the graph with `graphify . --update`, and that
refresh can fail SILENTLY in two shapes:

  - MISSING MODULE (issue #173): the 2026-09-12 refresh produced a graph without
    `src/paths.ts`, added the day before; nothing reported a problem. Absence
    from the tool was read as truth.
  - STALE REWRITE (issue #189): the 2026-09-20 `cluster-only` run rewrote
    graph.json from old content — module coverage stayed complete, the day's
    new symbols were gone, and every guard stayed green.

WHAT IT CHECKS (mechanical, no LLM, no network)
  1. MODULE COVERAGE — every `src/*.ts` on disk appears as a module node in the
     graph, and every module node in the graph still exists on disk.
  2. SYMBOL COVERAGE — every exported declaration (function/class/interface/
     type/enum/const/let/var, including `export default` / `async` / `abstract`)
     in `src/*.ts` appears as a node with a matching `source_file`.
  3. FRESHNESS — graph.json is not older than the newest `src/*.ts`.

WHAT IT DOES NOT CHECK — stated boundaries (issue #189: a guard states its coverage)
  - Re-exports and aliases (`export { a } …`, `export * as ns`, bare
    `export default identifier`) — not matched by the symbol pattern.
  - Non-exported symbols.
  - Nested paths: module and symbol coverage cover direct children of `src/`
    only (`src/__tests__/**` and any subdirectories are outside scope).
  - Link/edge correctness, community labels, rationale/concept/document nodes.

Ground truth is the filesystem and the graph JSON. Nothing else.

USAGE
    python3 .pi/skills/worktree/graph-check.py [--repo-root <path>] [--quiet]

Exit codes: 0 = graph verified against disk; 1 = discrepancy (details printed);
            2 = cannot check (missing inputs).

Called from: the release ritual (references/release-ritual.md step 7) after `graphify . --update`.
"""

import argparse
import glob
import json
import os
import re
import sys
from pathlib import Path

# Exported declaration forms. Deliberately conservative: they mirror what the
# extractor reliably turns into nodes, so the check carries no false positives
# for forms it cannot see. Forms outside this set are named in the boundaries.
EXPORT_RE = re.compile(
    r"^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?"
    r"(?:function\s*\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)",
    re.M,
)


def repo_root_from_script() -> Path:
    # <root>/.pi/skills/worktree/graph-check.py -> <root>
    return Path(__file__).resolve().parents[3]


def symbol_index(data: dict) -> dict:
    """source_file -> set of node names (lowercased; callables strip `()`)."""
    index = {}
    for node in data.get("nodes", []):
        sf = node.get("source_file") or ""
        names = set()
        for key in ("label", "norm_label", "id"):
            value = node.get(key)
            if not value:
                continue
            text = str(value)
            if text.endswith("()"):
                text = text[:-2]
            names.add(text.lower())
        if names:
            index.setdefault(sf, set()).update(names)
    return index


def main() -> int:
    ap = argparse.ArgumentParser(description="Verify the graph against src/ on disk.")
    ap.add_argument("--repo-root", default=None,
                    help="Repository root (default: derived from this script's location)")
    ap.add_argument("--quiet", action="store_true", help="Print nothing when the check passes")
    args = ap.parse_args()

    root = Path(args.repo_root).resolve() if args.repo_root else repo_root_from_script()
    graph_path = root / "graphify-out" / "graph.json"

    if not graph_path.exists():
        print(f"ERROR: {graph_path} not found — run `graphify . --update` first.", file=sys.stderr)
        return 2

    src_dir = root / "src"
    if not src_dir.is_dir():
        print(f"ERROR: {src_dir} not found — wrong repo root?", file=sys.stderr)
        return 2

    try:
        data = json.loads(graph_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"ERROR: cannot read {graph_path}: {exc}", file=sys.stderr)
        return 2

    # --- 1. MODULE COVERAGE ---------------------------------------------------
    # A "module node" is a node whose source_file is a direct child of src/
    # (src/foo.ts). Deeper paths (src/__tests__/...) are not module coverage.
    graph_modules = set()
    for node in data.get("nodes", []):
        sf = node.get("source_file") or ""
        if sf.startswith("src/") and sf.count("/") == 1 and sf.endswith(".ts"):
            graph_modules.add(os.path.basename(sf))

    disk_src = sorted(glob.glob(str(src_dir / "*.ts")))
    disk_modules = {os.path.basename(p) for p in disk_src}

    missing = sorted(disk_modules - graph_modules)   # on disk, absent from the graph  <- the silent failure
    stale = sorted(graph_modules - disk_modules)     # in the graph, deleted from disk

    # --- 2. SYMBOL COVERAGE ---------------------------------------------------
    index = symbol_index(data)
    exported_total = 0
    missing_symbols = []
    for p in disk_src:
        rel = f"src/{os.path.basename(p)}"
        try:
            text = Path(p).read_text(encoding="utf-8")
        except OSError as exc:
            print(f"ERROR: cannot read {p}: {exc}", file=sys.stderr)
            return 2
        names = EXPORT_RE.findall(text)
        exported_total += len(names)
        have = index.get(rel, set())
        for name in names:
            if name.lower() not in have:
                missing_symbols.append((rel, name))
    missing_symbols.sort()

    # --- 3. FRESHNESS ---------------------------------------------------------
    graph_mtime = graph_path.stat().st_mtime
    newest_src = None
    newest_mtime = 0.0
    for p in disk_src:
        m = os.path.getmtime(p)
        if m > newest_mtime:
            newest_mtime, newest_src = m, os.path.basename(p)
    graph_is_stale = newest_mtime > graph_mtime

    # --- REPORT ---------------------------------------------------------------
    ok = not missing and not stale and not missing_symbols and not graph_is_stale

    if not args.quiet or not ok:
        print(f"Graph: {graph_path.relative_to(root)}")
        print(f"  module coverage: {len(graph_modules)} in graph / {len(disk_modules)} on disk")
        print(f"  symbol coverage: {len(missing_symbols)} missing of {exported_total} exported declarations")
        if missing:
            print(f"  ✗ MODULES MISSING from graph ({len(missing)}): {', '.join(missing)}")
            print("      -> the refresh was incomplete. Re-run a FULL build; if it still")
            print("         omits them, the extraction is broken — do not proceed to release.")
        if stale:
            print(f"  ✗ MODULES DELETED from disk but still in graph ({len(stale)}): {', '.join(stale)}")
            print("      -> expected after a deletion; a full rebuild should drop them.")
        if missing_symbols:
            shown = missing_symbols[:15]
            print(f"  ✗ SYMBOLS MISSING from graph ({len(missing_symbols)}):")
            for rel, name in shown:
                print(f"        {name}  ({rel})")
            if len(missing_symbols) > len(shown):
                print(f"        … and {len(missing_symbols) - len(shown)} more")
            print("      -> the graph was rewritten from stale content (issue #189) or the")
            print("         extraction regressed. Re-run a FULL build before trusting it.")
        if graph_is_stale:
            print(f"  ✗ STALE: graph.json is older than src/{newest_src} — refresh required.")
        if ok:
            print("  ✓ coverage complete; graph is not older than src/")
        print("  boundaries: NOT checked — re-exports/aliases, non-exported symbols, nested")
        print("              paths (src/__tests__/**), links/edges, community labels, semantic nodes")

    if ok:
        return 0

    print("\nGRAPH-CHECK FAILED — the graph does not match src/ on disk.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())

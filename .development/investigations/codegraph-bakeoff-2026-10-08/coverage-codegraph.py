#!/usr/bin/env python3
"""coverage-codegraph.py — CodeGraph analogue of graph-check.py (Phase 0 prototype).

WHY THIS EXISTS
Phase 0 of the CodeGraph bake-off (2026-10-08) asked whether CodeGraph can reproduce
graph-check.py's coverage bar, so a replacement guard would keep catching the silent
refresh failures of issues #173 (missing module) and #189 (stale rewrite). It can:
34/34 modules, 0 missing of 322 exported declarations, in ~5ms.

WHAT IT CHECKS (mechanical; no LLM, no network)
  1. MODULE COVERAGE — every `src/*.ts` on disk appears as a `kind='file'` node.
  2. SYMBOL COVERAGE — every exported declaration (same regex as graph-check.py) in
     `src/*.ts` appears as a node whose name / qualified_name / id matches.
  3. FRESHNESS — `project_metadata.indexed_at_commit` equals git HEAD and
     `index_state = 'complete'` (stronger than graph-check.py's mtime comparison).

WHAT IT DOES NOT CHECK — boundaries (mirrors graph-check.py, plus CodeGraph-specific)
  - Re-exports and aliases, non-exported symbols, nested paths (`src/__tests__/**`).
  - Link/edge correctness, unresolved refs (see the bake-off findings' boundaries),
    markdown/docs (CodeGraph does not index them).
  - Nodes match by NAME, not by (name, kind): a same-named non-exported node in the
    right file satisfies the symbol check (graph-check.py has the same semantics).

USAGE
    python3 coverage-codegraph.py [repo-root] [--db <path>] [--quiet]

Exit codes: 0 = index verified against disk; 1 = discrepancy; 2 = cannot check.
"""

import argparse
import os
import re
import sqlite3
import subprocess
import sys
from pathlib import Path

EXPORT_RE = re.compile(
    r"^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?"
    r"(?:function\s*\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)",
    re.M,
)


def main() -> int:
    ap = argparse.ArgumentParser(description="Verify the CodeGraph index against src/ on disk.")
    ap.add_argument("repo_root", nargs="?", default=".", help="Repository root (default: .)")
    ap.add_argument("--db", default=None, help="Path to codegraph.db (default: <root>/.codegraph/codegraph.db)")
    ap.add_argument("--quiet", action="store_true", help="Print nothing when the check passes")
    args = ap.parse_args()

    root = Path(args.repo_root).resolve()
    db = Path(args.db) if args.db else root / ".codegraph" / "codegraph.db"
    if not db.exists():
        print(f"ERROR: {db} not found — run `codegraph init`/`codegraph sync` first.", file=sys.stderr)
        return 2
    src_dir = root / "src"
    if not src_dir.is_dir():
        print(f"ERROR: {src_dir} not found — wrong repo root?", file=sys.stderr)
        return 2

    disk_src = sorted(src_dir.glob("*.ts"))
    disk_modules = {p.name for p in disk_src}
    disk_symbols, exported_total = {}, 0
    for p in disk_src:
        names = EXPORT_RE.findall(p.read_text(encoding="utf-8"))
        disk_symbols[f"src/{p.name}"] = names
        exported_total += len(names)

    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    graph_modules, names_by_file = set(), {}
    for nid, kind, name, qname, fp in con.execute(
        "select id, kind, name, qualified_name, file_path from nodes"
    ):
        if kind == "file" and fp and fp.startswith("src/") and fp.count("/") == 1 and fp.endswith(".ts"):
            graph_modules.add(os.path.basename(fp))
        if fp:
            names = names_by_file.setdefault(fp, set())
            for value in (name, qname, nid):
                if value:
                    text = str(value)
                    if text.endswith("()"):
                        text = text[:-2]
                    names.add(text.lower())

    missing = sorted(disk_modules - graph_modules)
    stale = sorted(graph_modules - disk_modules)
    missing_symbols = [
        (rel, name)
        for rel, names in disk_symbols.items()
        for name in names
        if name.lower() not in names_by_file.get(rel, set())
    ]

    state = dict(con.execute("select key, value from project_metadata"))
    declared = state.get("indexed_at_commit")
    try:
        head = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "HEAD"],
            capture_output=True, text=True, check=False,
        ).stdout.strip() or None
    except OSError:
        head = None
    commit_ok = bool(declared and head and declared == head)
    state_ok = state.get("index_state") == "complete"

    ok = not missing and not stale and not missing_symbols and commit_ok and state_ok

    if not args.quiet or not ok:
        print(f"CodeGraph: {db}")
        print(f"  module coverage: {len(graph_modules)} in graph / {len(disk_modules)} on disk")
        print(f"  symbol coverage: {len(missing_symbols)} missing of {exported_total} exported declarations")
        if missing:
            print(f"  ✗ MODULES MISSING from graph ({len(missing)}): {', '.join(missing)}")
            print("      -> sync was incomplete. Run `codegraph index` (full rebuild); if they")
            print("         are still absent, the extraction is broken — do not proceed.")
        if stale:
            print(f"  ✗ MODULES DELETED from disk but still in graph ({len(stale)}): {', '.join(stale)}")
            print("      -> expected after a deletion; a full rebuild should drop them.")
        shown = missing_symbols[:15]
        for rel, name in shown:
            print(f"        {name}  ({rel})")
        if len(missing_symbols) > len(shown):
            print(f"        … and {len(missing_symbols) - len(shown)} more")
        if not commit_ok:
            print(f"  ✗ FRESHNESS: indexed_at_commit={declared} vs HEAD={head} — run `codegraph sync`")
        if not state_ok:
            print(f"  ✗ index_state={state.get('index_state')!r} (expected 'complete')")
        if ok:
            print("  ✓ coverage complete; index reflects HEAD")
        print("  boundaries: NOT checked — re-exports/aliases, non-exported symbols, nested")
        print("              paths (src/__tests__/**), links/edges, unresolved refs, markdown/docs")

    if ok:
        return 0
    print("\nCOVERAGE CHECK FAILED — the CodeGraph index does not match src/ on disk.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())

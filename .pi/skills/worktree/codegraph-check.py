#!/usr/bin/env python3
"""codegraph-check.py — verify the CodeGraph index against ground truth.

STATUS: **the merge gate's guard.** CodeGraph is the sole structural index
(ADR 0016); the graphify layer and its `graph-check.py` are retired. Run at every
merge into `dev` after `codegraph-refresh.sh`, and on demand; this script changes
nothing about the release ritual beyond that gate. Findings:
.development/investigations/codegraph-bakeoff-2026-10-08/findings.md

WHY THIS EXISTS
Same failure family as the retired graph-check.py, different tool: a refresh can
leave the index missing a module (#173-class) or describing something other than
the tree on disk (#189-class). CodeGraph's index is deterministic, but a guard
still belongs at the point of use — and its metadata makes the freshness check
STRONGER than the retired mtime comparison: the index declares the commit it was
built from.

WHAT IT CHECKS (mechanical; no LLM, no network)
  1. MODULE COVERAGE — every `src/*.ts` on disk appears as a `kind='file'` node,
     and every such node still exists on disk.
  2. SYMBOL COVERAGE — every exported declaration (the exported-declaration
     regex below) in `src/*.ts` appears as a node whose name / qualified_name /
     id matches, in the node's `file_path`.
  3. FRESHNESS — `project_metadata.indexed_at_commit` equals git HEAD and
     `index_state = 'complete'`. If HEAD is unavailable (not a checkout), the
     commit assertion is reported as unverified, not silently skipped.
  4. DIRTY-PATHS ADVISORY — `indexed_dirty_paths` lists indexed code files whose
     content is not in HEAD (untracked or modified). Non-empty = warning, never a
     failure: an ad-hoc sync on a dirty tree is legitimate, but a query result
     derived from it should say so.

WHAT IT DOES NOT CHECK — boundaries (the retired graph-check.py's, plus CodeGraph's)
  - Re-exports and aliases (`export { a } …`), non-exported symbols, nested paths
    (`src/__tests__/**` and any subdirectories) — module and symbol coverage
    cover direct children of `src/` only.
  - Link/edge correctness, unresolved refs, community labels, semantic nodes.
  - Markdown/docs — CodeGraph does not index them at all (docs-only changes are
    no-ops; see the bake-off findings).
  - Nodes match by NAME, not by (name, kind): a same-named non-exported node in
    the right file satisfies the symbol check.

USAGE
    python3 codegraph-check.py [--repo-root <path>] [--db <path>] [--quiet]

Exit codes: 0 = index verified against disk; 1 = discrepancy; 2 = cannot check.
"""

import argparse
import json
import os
import re
import sqlite3
import subprocess
import sys
from pathlib import Path

# Exported declaration forms — carried over verbatim from the retired
# graph-check.py, so the guard asks exactly the same question about the corpus.
EXPORT_RE = re.compile(
    r"^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?"
    r"(?:function\s*\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)",
    re.M,
)


def repo_root_from_script() -> Path:
    # <root>/.pi/skills/worktree/codegraph-check.py -> <root>
    return Path(__file__).resolve().parents[3]


def main() -> int:
    ap = argparse.ArgumentParser(description="Verify the CodeGraph index against src/ on disk.")
    ap.add_argument("--repo-root", default=None, help="Repository root (default: derived from this script)")
    ap.add_argument("--db", default=None, help="Path to codegraph.db (default: <root>/.codegraph/codegraph.db)")
    ap.add_argument("--quiet", action="store_true", help="Print nothing when the check passes")
    args = ap.parse_args()

    root = Path(args.repo_root).resolve() if args.repo_root else repo_root_from_script()
    db = Path(args.db) if args.db else root / ".codegraph" / "codegraph.db"
    if not db.exists():
        print(f"ERROR: {db} not found — run `codegraph init` / the refresh script first.", file=sys.stderr)
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

    # Freshness — declared, not inferred (Phase 0 finding).
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
    commit_verifiable = bool(declared and head)
    state_ok = state.get("index_state") == "complete"

    dirty_paths = []
    try:
        dirty = json.loads(state.get("indexed_dirty_paths") or "{}")
        if isinstance(dirty, dict):
            dirty_paths = [p for p in dirty.get("paths", []) if isinstance(p, str)]
    except (TypeError, ValueError):
        dirty_paths = []

    ok = not missing and not stale and not missing_symbols and commit_ok and state_ok

    if not args.quiet or not ok or dirty_paths:
        print(f"CodeGraph: {db}")
        print(f"  module coverage: {len(graph_modules)} in graph / {len(disk_modules)} on disk")
        print(f"  symbol coverage: {len(missing_symbols)} missing of {exported_total} exported declarations")
        if missing:
            print(f"  ✗ MODULES MISSING from graph ({len(missing)}): {', '.join(missing)}")
            print("      -> the sync was incomplete. Run a full rebuild (`codegraph index`); if")
            print("         they are still absent, the extraction is broken — do not proceed.")
        if stale:
            print(f"  ✗ MODULES DELETED from disk but still in graph ({len(stale)}): {', '.join(stale)}")
            print("      -> expected after a deletion; a full rebuild should drop them.")
        shown = missing_symbols[:15]
        for rel, name in shown:
            print(f"        {name}  ({rel})")
        if len(missing_symbols) > len(shown):
            print(f"        … and {len(missing_symbols) - len(shown)} more")
        if not commit_ok:
            if commit_verifiable:
                print(f"  ✗ FRESHNESS: indexed_at_commit={declared} vs HEAD={head} — run the refresh script")
            else:
                print(f"  ✗ FRESHNESS UNVERIFIED: indexed_at_commit={declared!r}, HEAD={head!r}")
        if not state_ok:
            print(f"  ✗ index_state={state.get('index_state')!r} (expected 'complete')")
        if dirty_paths:
            shown_dirty = dirty_paths[:6]
            more = f" … +{len(dirty_paths) - len(shown_dirty)}" if len(dirty_paths) > len(shown_dirty) else ""
            print(f"  ⚠ index includes uncommitted changes ({len(dirty_paths)}): {', '.join(shown_dirty)}{more}")
            print("      -> advisory only; queries reflect the working tree, not HEAD.")
        if ok:
            print("  ✓ coverage complete; index was built from HEAD")
        print("  boundaries: NOT checked — re-exports/aliases, non-exported symbols, nested")
        print("              paths (src/__tests__/**), links/edges, unresolved refs, markdown/docs")

    if ok:
        return 0
    print("\nCODEGRAPH-CHECK FAILED — the index does not match src/ on disk.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())

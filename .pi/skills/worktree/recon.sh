#!/usr/bin/env bash
# recon.sh — Rule 13 recon: run the standard CodeGraph queries for a target and
# print a paste-ready `## Recon` block for a C1/C2 spec.
#
# Usage: recon.sh <symbol|file> [--file <path>] [--grep] [--repo-root <path>]
#   <symbol|file>   symbol name, or a source file (path or basename)
#   --file <path>   additionally run `affected` for this source file
#   --grep          also print the raw grep hit count (comments included)
#   --repo-root     cockpit root (default: derived from this script)
#
# Freshness: when `indexed_at_commit != HEAD`, runs codegraph-refresh.sh first
# (index stale = results silently wrong; 1 s to fix).
#
# Exit: 0 ok · 2 usage/CLI missing · 3 stale index that could not refresh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}/../../.."
TARGET=""
FILE=""
DO_GREP=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --file) FILE="$2"; shift 2 ;;
        --grep) DO_GREP=1; shift ;;
        --repo-root) REPO_ROOT="$2"; shift 2 ;;
        -*) echo "Unknown argument: $1" >&2; exit 2 ;;
        *) TARGET="$1"; shift ;;
    esac
done

[[ -n "${TARGET}" ]] || { echo "Usage: recon.sh <symbol|file> [--file <path>] [--grep] [--repo-root <path>]" >&2; exit 2; }
REPO_ROOT="$(cd "${REPO_ROOT}" && pwd)"
CODEGRAPH_BIN="${CODEGRAPH_BIN:-codegraph}"

[[ -d "${REPO_ROOT}/src" ]] || { echo "ERROR: no src/ in ${REPO_ROOT} — wrong cockpit root?" >&2; exit 2; }
command -v "${CODEGRAPH_BIN}" >/dev/null 2>&1 || { echo "ERROR: ${CODEGRAPH_BIN} is not on PATH (set CODEGRAPH_BIN)." >&2; exit 2; }

HEAD_SHA="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
DB="${REPO_ROOT}/.codegraph/codegraph.db"

indexed_at() {
    python3 - "${DB}" <<'PY' 2>/dev/null || true
import sqlite3, sys
try:
    con = sqlite3.connect(sys.argv[1])
    row = con.execute("select value from project_metadata where key='indexed_at_commit'").fetchone()
    print(row[0] if row else "")
except Exception:
    print("")
PY
}

# --- freshness gate -------------------------------------------------------
INDEXED="$(indexed_at)"
if [[ "${INDEXED}" != "${HEAD_SHA}" ]]; then
    echo "recon: index stale (indexed ${INDEXED:0:12} != HEAD ${HEAD_SHA:0:12}) — refreshing…" >&2
    bash "${SCRIPT_DIR}/codegraph-refresh.sh" --repo-root "${REPO_ROOT}" >/dev/null 2>&1 || true
    INDEXED="$(indexed_at)"
    if [[ "${INDEXED}" != "${HEAD_SHA}" ]]; then
        echo "ERROR: index still stale after refresh — refusing to emit recon." >&2
        exit 3
    fi
fi
SHORT="$(git -C "${REPO_ROOT}" rev-parse --short HEAD)"

# --- target typing --------------------------------------------------------
IS_FILE=0
case "${TARGET}" in
    *.ts|*.tsx|*.js|*.mjs|*.cjs|*.py) IS_FILE=1 ;;
esac
[[ -f "${REPO_ROOT}/${TARGET}" ]] && IS_FILE=1

BASENAME="${TARGET##*/}"
SYMBOL="${TARGET}"
# A file target implies its own affected-tests set.
if [[ "${IS_FILE}" -eq 1 && -z "${FILE}" ]]; then FILE="${TARGET}"; fi

json() { "${CODEGRAPH_BIN}" "$@" -p "${REPO_ROOT}" 2>/dev/null || true; }

echo "## Recon (Rule 13 — codegraph @ ${SHORT})"
echo "- target: \`${TARGET}\`${FILE:+ (file: ${FILE})}"

if [[ "${IS_FILE}" -eq 1 ]]; then
    echo "- impact(${BASENAME}, depth 2):"
    json impact "${BASENAME}" -j -d 2 | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("  - (impact returned no JSON)"); raise SystemExit
aff = d.get("affected") or []
files = []
for e in aff:
    f = e.get("filePath") or e.get("file") or e.get("name")
    if f and f not in files:
        files.append(f)
print(f"  - {len(aff)} affected symbols across {len(files)} files")
if files:
    print("  - files: " + ", ".join(files[:8]) + (" …" if len(files) > 8 else ""))
'
else
    echo "- callers(${SYMBOL}):"
    json callers "${SYMBOL}" -j -l 25 | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("  - (callers returned no JSON)"); raise SystemExit
cs = d.get("callers") or []
print(f"  - {len(cs)} caller(s)" + (" (truncated)" if d.get("truncated") else ""))
for c in cs[:12]:
    name = c.get("name") or "?"
    fp = c.get("filePath") or "?"
    ln = c.get("startLine")
    where = f"{fp}:{ln}" if ln is not None else fp
    print(f"  - {where} ({name})")
if len(cs) > 12:
    print(f"  - … +{len(cs) - 12} more")
'
    echo "- impact(${SYMBOL}, depth 2):"
    json impact "${SYMBOL}" -j -d 2 | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("  - (impact returned no JSON)"); raise SystemExit
aff = d.get("affected") or []
files = []
for e in aff:
    f = e.get("filePath") or e.get("file") or e.get("name")
    if f and f not in files:
        files.append(f)
print(f"  - {len(aff)} affected symbols across {len(files)} files")
if files:
    print("  - files: " + ", ".join(files[:8]) + (" …" if len(files) > 8 else ""))
'
fi

if [[ -n "${FILE}" ]]; then
    echo "- affected(${FILE}):"
    json affected "${FILE}" -j | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("  - (affected returned no JSON)"); raise SystemExit
tests = d.get("affectedTests") or []
print(f"  - {len(tests)} test file(s)")
rel = [t for t in tests if any(k in t for k in ("runner", "recover", "registry", "kill", "session-manager", "terminal", "notify"))] or tests[:8]
for t in rel[:10]:
    print(f"  - {t}")
'
fi

if [[ "${DO_GREP}" -eq 1 ]]; then
    if [[ "${IS_FILE}" -eq 1 ]]; then STEM="${BASENAME%.*}"; else STEM="${TARGET}"; fi
    HITS="$(grep -rn --include='*.ts' -E "\\b${STEM}\\b" "${REPO_ROOT}/src" 2>/dev/null | wc -l || true)"
    echo "- grep delta: ${HITS} raw hits for \`${STEM}\` (incl. comments/strings) — record what grep added or the graph missed"
else
    echo "- grep delta: <run grep after this block; record what grep added or the graph missed>"
fi

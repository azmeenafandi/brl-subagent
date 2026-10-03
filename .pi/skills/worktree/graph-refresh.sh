#!/usr/bin/env bash
# graph-refresh.sh — refresh + validate the canonical knowledge graph.
#
# The canonical graph describes the COCKPIT (dev) tree and is refreshed at
# every merge into `dev` (worktree lifecycle step 6). Hooks (the Rule 11
# graph check) only READ and validate the graph — they never rebuild it
# (issue #230: hook-triggered rebuilds produced incomplete graphs).
#
# Part of the worktree framework. Usage:
#   ./graph-refresh.sh [--repo-root <path>]
#     --repo-root  cockpit root to refresh (default: derived from this script;
#                  override it during the 2026-09-30 cockpit-move transition,
#                  when this script still lives in the old checkout)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}/../../.."

while [[ $# -gt 0 ]]; do
    case "$1" in
        --repo-root) REPO_ROOT="$2"; shift 2 ;;
        *) echo "Unknown argument: $1" >&2; exit 2 ;;
    esac
done
REPO_ROOT="$(cd "${REPO_ROOT}" && pwd)"

echo "graph-refresh: cockpit root = ${REPO_ROOT}"
if [[ ! -d "${REPO_ROOT}/src" ]]; then
    echo "ERROR: no src/ in ${REPO_ROOT} — wrong cockpit root?" >&2
    exit 2
fi
if ! command -v graphify >/dev/null 2>&1; then
    echo "ERROR: graphify is not on PATH — cannot refresh." >&2
    exit 2
fi

cd "${REPO_ROOT}"
graphify . --update

echo ""
echo "graph-refresh: validating (module + symbol coverage)…"
python3 "${SCRIPT_DIR}/graph-check.py" --repo-root "${REPO_ROOT}"
echo "graph-refresh: done — the graph is current for ${REPO_ROOT}."

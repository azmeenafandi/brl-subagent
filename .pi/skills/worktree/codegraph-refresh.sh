#!/usr/bin/env bash
# codegraph-refresh.sh — refresh + validate the CodeGraph index (the merge gate).
#
# STATUS: **the gate.** CodeGraph is the sole structural index (ADR 0016); the
# graphify layer it replaced is retired. Run at EVERY merge into `dev` (lifecycle
# step 6) — explicit invocation, never a hook (#230). Landed by the 2026-10-08
# bake-off (Phase 1). Findings:
#   .development/investigations/codegraph-bakeoff-2026-10-08/findings.md
#   .development/decisions/0016-retire-graphify.md
#
# Contract: refresh the index, then assert coverage + freshness
# (codegraph-check.py). `sync` is incremental and deterministic; docs-only
# changes are no-ops because markdown is not indexed. Explicit invocation only,
# never a hook (#230).
#
# Usage:
#   ./codegraph-refresh.sh [--repo-root <path>] [--full]
#     --repo-root  cockpit root to refresh (default: derived from this script)
#     --full       full rebuild (`codegraph index`) instead of incremental `sync`
#
# Env:
#   CODEGRAPH_BIN  path to the codegraph binary (default: `codegraph` on PATH);
#                  install pinned: npm i -g @colbymchenry/codegraph@1.6.2
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}/../../.."
MODE="sync"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --repo-root) REPO_ROOT="$2"; shift 2 ;;
        --full) MODE="index"; shift ;;
        *) echo "Unknown argument: $1" >&2; exit 2 ;;
    esac
done
REPO_ROOT="$(cd "${REPO_ROOT}" && pwd)"
CODEGRAPH_BIN="${CODEGRAPH_BIN:-codegraph}"

echo "codegraph-refresh: cockpit root = ${REPO_ROOT} | mode = ${MODE}"
if [[ ! -d "${REPO_ROOT}/src" ]]; then
    echo "ERROR: no src/ in ${REPO_ROOT} — wrong cockpit root?" >&2
    exit 2
fi
if ! command -v "${CODEGRAPH_BIN}" >/dev/null 2>&1; then
    echo "ERROR: ${CODEGRAPH_BIN} is not on PATH (set CODEGRAPH_BIN to its path)." >&2
    echo "       install pinned: pnpm add -g @colbymchenry/codegraph@1.6.2" >&2
    exit 2
fi
if [[ ! -f "${REPO_ROOT}/.codegraph/codegraph.db" ]]; then
    echo "ERROR: ${REPO_ROOT} has no CodeGraph index — initialize it once:" >&2
    echo "       DO_NOT_TRACK=1 ${CODEGRAPH_BIN} init ${REPO_ROOT}" >&2
    exit 2
fi

cd "${REPO_ROOT}"
# Telemetry stays off regardless of the user-level preference file (Phase 0 finding).
DO_NOT_TRACK=1 "${CODEGRAPH_BIN}" "${MODE}" .

echo ""
python3 "${SCRIPT_DIR}/codegraph-check.py" --repo-root "${REPO_ROOT}"

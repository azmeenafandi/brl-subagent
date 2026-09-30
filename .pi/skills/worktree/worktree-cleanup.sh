#!/usr/bin/env bash
# worktree-cleanup.sh — tear down a worktree after its PR is merged (or closed).
# Part of the worktree framework (see .development/WORKTREE_FRAMEWORK.md).
#
# Usage: worktree-cleanup.sh <worktree-path> [--branch <name>] [--repo-root <path>] [--skip-extension-sync]
#
# UNCONDITIONAL: runs the same whether the PR was merged or closed without merge.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKTREE_PATH=""
BRANCH=""
REPO_ROOT=""
SKIP_EXT_SYNC=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --branch) BRANCH="$2"; shift 2 ;;
        --repo-root) REPO_ROOT="$2"; shift 2 ;;
        --skip-extension-sync) SKIP_EXT_SYNC=true; shift ;;
        -h|--help) grep '^#' "$0" | head -20; exit 0 ;;
        *) WORKTREE_PATH="$1"; shift ;;
    esac
done

if [[ -z "${WORKTREE_PATH}" ]]; then
    echo "ERROR: worktree path required. Usage: worktree-cleanup.sh <worktree-path> [--branch <name>] [--repo-root <path>]"
    exit 1
fi
REPO_ROOT="${REPO_ROOT:-$(cd "${SCRIPT_DIR}/../../.." && pwd)}"

echo "Cleaning up worktree: ${WORKTREE_PATH}"
echo "  cockpit repo: ${REPO_ROOT}"
echo ""

# ── 1. Remove the worktree from disk ─────────────────────────────────────
if [[ -d "${WORKTREE_PATH}" ]]; then
    (cd "${REPO_ROOT}" && git worktree remove --force "${WORKTREE_PATH}")
    echo "  worktree removed: ${WORKTREE_PATH}"
else
    echo "  worktree already gone: ${WORKTREE_PATH}"
fi

# ── 2. Delete the branch ─────────────────────────────────────────────────
if [[ -n "${BRANCH}" ]]; then
    if (cd "${REPO_ROOT}" && git show-ref --verify --quiet "refs/heads/${BRANCH}" 2>/dev/null); then
        (cd "${REPO_ROOT}" && git branch -D "${BRANCH}")
        echo "  branch deleted: ${BRANCH}"
    else
        echo "  branch already gone: ${BRANCH}"
    fi
fi

# ── 3. Sync the cockpit checkout (fetch + pull) ──────────────────────────
CUR_BRANCH="$(cd "${REPO_ROOT}" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
if [[ "${CUR_BRANCH}" != "dev" ]]; then
    echo "  WARNING: cockpit checkout is on '${CUR_BRANCH}', not dev — skipping fetch/pull"
else
    (cd "${REPO_ROOT}" && git fetch origin --quiet && git pull --rebase origin dev --quiet)
    echo "  cockpit synced with origin/dev"
fi

# ── 3b. Shared node_modules staleness after a merged bump (issue #100, M1) ──
# A bump worktree is --force-isolated: its npm ci updates the WORKTREE's
# node_modules, never the cockpit's shared tree. After merge, the cockpit's
# lockfile advances but its node_modules stays old → the #95-class recurrence
# (tests silently running the wrong SDK). Shared helper (same function as
# check-repo.sh §1b) — loud, but does NOT auto-install: a cockpit npm ci is a
# deliberate conductor ritual (run it only while no worktree is linked).
# shellcheck source=lib/version-skew.sh
source "${SCRIPT_DIR}/lib/version-skew.sh"
if ! check_sdk_version_skew "${REPO_ROOT}"; then
    echo "  WARNING: the cockpit's node_modules is stale vs the merged lockfile — run 'npm ci' in the cockpit before the next pre-flight."
fi

# ── 4. Sync the installed extension ──────────────────────────────────────
if [[ "${SKIP_EXT_SYNC}" != "true" && -x "${REPO_ROOT}/sync-extension.sh" ]]; then
    (cd "${REPO_ROOT}" && ./sync-extension.sh)
    echo "  extension synced"
else
    echo "  extension sync skipped (--skip-extension-sync or script missing)"
fi

echo ""
echo "Cleanup complete."

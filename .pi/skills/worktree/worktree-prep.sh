#!/usr/bin/env bash
# worktree-prep.sh — provision a freshly-created worktree for delegation work.
# Part of the worktree framework (see .development/WORKTREE_FRAMEWORK.md).
#
# Usage: worktree-prep.sh <worktree-path> [--repo-root <path>] [--include-dev-docs] [--force-isolated]
#
#   <worktree-path>       Absolute path of the worktree (e.g. ../brl-subagent-my-branch)
#   --repo-root <path>    Main repo checkout (default: derived from this script's location)
#   --include-dev-docs    Also symlink .development/ into the worktree (reviewer context)
#   --force-isolated      Force isolated 'npm ci' in the worktree (dependency-bump worktree;
#                         lockfiles will diverge BY DESIGN — see issue #100).
#
# Decisions (per framework):
#   - node_modules: SYMLINK to the cockpit repo's IF lockfiles match; else isolated `npm ci`.
#     --force-isolated overrides: always isolated (dependency-bump worktree).
#   - sync-extension.sh: provisioned (gitignored — never materializes otherwise).
#   - smoke test: vitest must run in the worktree before any subagent starts.
#   - pre-flight: check-repo.sh runs first — never provision from a broken source of truth.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKTREE_PATH=""
REPO_ROOT=""
INCLUDE_DEV_DOCS=false
FORCE_ISOLATED=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --repo-root) REPO_ROOT="$2"; shift 2 ;;
        --include-dev-docs) INCLUDE_DEV_DOCS=true; shift ;;
        --force-isolated) FORCE_ISOLATED=true; shift ;;
        -h|--help) grep '^#' "$0" | head -22; exit 0 ;;
        *) WORKTREE_PATH="$1"; shift ;;
    esac
done

if [[ -z "${WORKTREE_PATH}" ]]; then
    echo "ERROR: worktree path required. Usage: worktree-prep.sh <worktree-path> [--repo-root <path>] [--include-dev-docs] [--force-isolated]"
    exit 1
fi
REPO_ROOT="${REPO_ROOT:-$(cd "${SCRIPT_DIR}/../../.." && pwd)}"

# ── 0. Pre-flight: never provision from a broken source of truth ────────────
# decision #3: check-repo.sh is the standalone health gate; wiring it in here
# (m5) makes prep self-guarding instead of relying on the conductor to have
# run it separately.
if ! "${SCRIPT_DIR}/check-repo.sh" "${REPO_ROOT}"; then
    echo "ERROR: pre-flight failed — fix the cockpit checkout before provisioning a worktree."
    exit 1
fi

# ── Validate inputs ──────────────────────────────────────────────────────
if [[ ! -d "${WORKTREE_PATH}" ]]; then
    echo "ERROR: worktree directory does not exist: ${WORKTREE_PATH}"
    echo "Create it first: git worktree add <path> <branch>"
    exit 1
fi
# Accept linked worktrees: the cockpit (dev) has `.git` as a FILE (a linked
# worktree), not a directory — the old `-d .git` check broke provisioning the
# moment the cockpit moved off the main checkout (2026-09-30, caught by the
# Phase-2 dogfood). Ask git instead.
if ! git -C "${REPO_ROOT}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "ERROR: not a git repo root: ${REPO_ROOT}"
    exit 1
fi

echo "Preparing worktree: ${WORKTREE_PATH}"
echo "  cockpit repo:     ${REPO_ROOT}"
echo ""

# ── 1. node_modules: symlink or isolated install ─────────────────────────
LOCK_MATCH=true
if [[ -f "${WORKTREE_PATH}/package-lock.json" && -f "${REPO_ROOT}/package-lock.json" ]]; then
    if ! cmp -s "${WORKTREE_PATH}/package-lock.json" "${REPO_ROOT}/package-lock.json"; then
        LOCK_MATCH=false
    fi
fi

NM="${WORKTREE_PATH}/node_modules"

# --force-isolated: authoritative isolated install (dependency-bump worktree).
# [[ -d ]] FOLLOWS symlinks (verified in review), so key off -L/-e and remove FIRST.
if [[ "${FORCE_ISOLATED}" == "true" ]]; then
    if [[ -L "${NM}" || -e "${NM}" ]]; then
        echo "  node_modules: --force-isolated — removing existing $( [[ -L "${NM}" ]] && echo symlink || echo dir )"
        rm -rf "${NM}"          # rm -rf on a symlink removes the link, not the target
    fi
    (cd "${WORKTREE_PATH}" && npm ci --silent)
    echo "  node_modules: FORCED isolated 'npm ci' (dependency-bump worktree)"
elif [[ -L "${NM}" && ! -e "${NM}" ]]; then
    # Dangling symlink (pre-existing bug, found in #100 review): [[ -d ]] is
    # false, falls through to ln -s → "File exists" → set -e aborts mid-provision.
    echo "  node_modules: dangling symlink found — removing and re-provisioning"
    rm -f "${NM}"
    if [[ "${LOCK_MATCH}" == "true" && -d "${REPO_ROOT}/node_modules" ]]; then
        ln -s "${REPO_ROOT}/node_modules" "${NM}"
        echo "  node_modules: SYMLINKED to the cockpit repo (lockfiles match — identical dependency graph)"
    else
        (cd "${WORKTREE_PATH}" && npm ci --silent)
        echo "  node_modules: installed via 'npm ci' (isolated)"
    fi
elif [[ -e "${NM}" || -L "${NM}" ]]; then
    echo "  node_modules: already present — leaving as-is"
elif [[ "${LOCK_MATCH}" == "true" && -d "${REPO_ROOT}/node_modules" ]]; then
    ln -s "${REPO_ROOT}/node_modules" "${NM}"
    echo "  node_modules: SYMLINKED to the cockpit repo (lockfiles match — identical dependency graph)"
else
    echo "  node_modules: lockfiles DIFFER or cockpit repo missing — isolated 'npm ci' in worktree"
    (cd "${WORKTREE_PATH}" && npm ci --silent)
    echo "  node_modules: installed via 'npm ci' (isolated)"
fi

# ── 2. sync-extension.sh (gitignored — never materializes) ───────────────
if [[ -f "${REPO_ROOT}/sync-extension.sh" ]]; then
    cp "${REPO_ROOT}/sync-extension.sh" "${WORKTREE_PATH}/sync-extension.sh"
    chmod +x "${WORKTREE_PATH}/sync-extension.sh"
    echo "  sync-extension.sh: provisioned"
else
    echo "  sync-extension.sh: NOT in the cockpit repo (nothing to copy)"
fi

# ── 3. Optional .development/ symlink (reviewer context) ─────────────────
if [[ "${INCLUDE_DEV_DOCS}" == "true" && -d "${REPO_ROOT}/.development" ]]; then
    if [[ ! -e "${WORKTREE_PATH}/.development" ]]; then
        ln -s "${REPO_ROOT}/.development" "${WORKTREE_PATH}/.development"
        echo "  .development/: symlinked (dev docs context)"
    fi
fi

# ── 4. Smoke test: vitest runs ───────────────────────────────────────────
echo ""
echo "  Smoke test: running vitest in worktree..."
if (cd "${WORKTREE_PATH}" && npx vitest run --reporter=dot 2>&1 | tail -3); then
    echo "  Smoke test: OK — worktree is ready for delegation."
else
    echo "  SMOKE TEST FAILED — worktree provisioned but tests do not run."
    echo "  Investigate before delegating; do NOT send a subagent into a broken worktree."
    exit 1
fi

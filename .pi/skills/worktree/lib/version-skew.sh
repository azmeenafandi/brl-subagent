#!/usr/bin/env bash
# lib/version-skew.sh — shared SDK version-skew check (issue #100, reviewer M1).
# Sourced by check-repo.sh (§1b) and worktree-cleanup.sh (§3b) — one function,
# two call sites (WORKTREE_FRAMEWORK.md decision #3's "same function, two call
# sites" intent). The #69/#95 lesson: presence is not enough, VERSIONS must
# match the lockfile — a stale main install silently tests the wrong SDK.
#
# Usage: check_sdk_version_skew <repo-root>
# Prints "✓/✗" verdict lines; returns 0 if all SDK versions match the
# lockfile, 1 if any mismatch or missing. Never installs — it only reports.
set -euo pipefail

check_sdk_version_skew() {
    local REPO_ROOT="$1"
    local LOCKFILE="${REPO_ROOT}/package-lock.json"
    local FAILED=0

    if [[ ! -f "${LOCKFILE}" ]]; then
        echo "  ✗ package-lock.json missing — cannot verify SDK versions"
        return 1
    fi

    for pkg in pi-coding-agent pi-agent-core pi-ai pi-tui; do
        installed="$(node -e "try{console.log(require('${REPO_ROOT}/node_modules/@earendil-works/${pkg}/package.json').version)}catch{console.log('')}" 2>/dev/null || echo '')"
        locked="$(node -e "const l=require('${LOCKFILE}'); const n=l.packages['node_modules/@earendil-works/${pkg}']; console.log(n?n.version:'')" 2>/dev/null || echo '')"
        if [[ -z "${installed}" ]]; then
            echo "  ✗ @earendil-works/${pkg} NOT INSTALLED — run 'npm ci' in the main repo"
            FAILED=1
        elif [[ -z "${locked}" ]]; then
            echo "  ✗ @earendil-works/${pkg} not found in lockfile — lockfile out of sync?"
            FAILED=1
        elif [[ "${installed}" != "${locked}" ]]; then
            echo "  ✗ @earendil-works/${pkg} version skew: installed ${installed} vs lockfile ${locked} — run 'npm ci' in the main repo"
            FAILED=1
        else
            echo "  ✓ @earendil-works/${pkg} ${installed} matches lockfile"
        fi
    done

    return "${FAILED}"
}

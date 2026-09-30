#!/usr/bin/env bash
# check-repo.sh — pre-flight: is the cockpit (dev) checkout healthy enough to build a worktree from?
# Part of the worktree framework (see .development/WORKTREE_FRAMEWORK.md).
# Usage: ./check-repo.sh [--repo-root <path>]   (defaults to the repo containing this script)
set -euo pipefail

# Resolve the cockpit repo root: the directory containing this script's parent's parent's .git
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${1:-$(cd "${SCRIPT_DIR}/../../.." && pwd)}"

# ── Helpers ──────────────────────────────────────────────────────────────
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; FAILED=1; }

# ── 1. Node modules pristine (source of truth) ───────────────────────────
echo "Pre-flight: ${REPO_ROOT}"
FAILED=0

NM="${REPO_ROOT}/node_modules"
LOCKFILE="${REPO_ROOT}/package-lock.json"
if [[ ! -d "${NM}" ]]; then
    fail "node_modules missing — run 'npm ci' in the cockpit ONCE (deps are repo-level only)"
elif [[ ! -d "${NM}/@earendil-works/pi-coding-agent" ]]; then
    fail "node_modules exists but is INCOMPLETE — SDK packages missing; repair with 'npm ci' in the cockpit"
else
    pass "node_modules present with SDK packages"
fi

# ── 1b. Installed SDK versions match the lockfile (issue #95 lesson) ────────
# The #69 bump refreshed package.json + lockfile but NOT the cockpit's own install —
# local runs tested 0.83.0's networking path for two weeks (the sdk-contract
# flake's true root cause). Presence (check 1) is not enough: versions must
# match the lockfile's resolved versions. Shared helper: one function, two
# call sites (also used by worktree-cleanup.sh §3b post-merge staleness).
# shellcheck source=lib/version-skew.sh
source "${SCRIPT_DIR}/lib/version-skew.sh"
if ! check_sdk_version_skew "${REPO_ROOT}"; then
    FAILED=1
fi

# ── 1c. pi runtime vs lockfile (informational — the pi-sdk group closes this) ──
# The live extension resolves @earendil-works/* from pi's own store, NOT from
# this repo's node_modules. So a green 1b (installed == lockfile) says nothing
# about runtime vs devDeps skew. This line makes that visible instead of letting
# a green pre-flight IMPLY runtime consistency (caught 2026-08-15: runtime 0.84.2,
# devDeps 0.84.1 — mild, probe-verified safe, Dependabot pi-sdk group aligns).
RUNTIME="$(pi --version 2>/dev/null || echo '')"
LOCKED_SDK="$(node -e "const l=require('${LOCKFILE}'); const n=l.packages['node_modules/@earendil-works/pi-coding-agent']; console.log(n?n.version:'')" 2>/dev/null || echo '')"
if [[ -z "${RUNTIME}" ]]; then
    echo "  ~ pi runtime not detectable (pi CLI not on PATH) — skipping runtime check"
elif [[ -z "${LOCKED_SDK}" ]]; then
    echo "  ~ runtime ${RUNTIME}, lockfile SDK unknown — lockfile out of sync?"
elif [[ "${RUNTIME}" == "${LOCKED_SDK}" ]]; then
    pass "pi runtime ${RUNTIME} matches lockfile SDK"
elif [[ "${RUNTIME}" > "${LOCKED_SDK}" ]]; then
    echo "  ~ pi runtime ${RUNTIME} is AHEAD of lockfile SDK ${LOCKED_SDK} — expected mid-cycle; the pi-sdk group bump will align (probe before trusting)"
else
    fail "pi runtime ${RUNTIME} is BEHIND lockfile SDK ${LOCKED_SDK} — tests exercise a newer SDK than the extension runs; upgrade pi or pin devDeps"
fi

# ── 1d. Typecheck gate (issue #117) — the repo's own tsc must be green ──
# #117 added a strict tsc --noEmit gate to CI; the pre-flight mirrors it so
# drift is caught locally BEFORE a worktree builds on top of it (a red gate
# in main means every worktree starts from a broken type contract). Uses the
# repo's own typescript (post-#117 it is a devDependency) — if tsc is missing
# here, that is itself a #117 regression to report, not to patch around.
TSC_BIN="${REPO_ROOT}/node_modules/.bin/tsc"
if [[ ! -x "${TSC_BIN}" ]]; then
    fail "typescript missing from node_modules — run 'npm ci' in the cockpit (post-#117 it is a devDependency; the gate requires it)"
else
    if (cd "${REPO_ROOT}" && "${TSC_BIN}" --noEmit >/dev/null 2>&1); then
        pass "typecheck green (tsc --noEmit)"
    else
        fail "typecheck RED — run 'npx tsc --noEmit' in the cockpit and fix before creating a worktree"
    fi
fi

# ── 2. Lockfile consistent with package.json ─────────────────────────────
if [[ ! -f "${LOCKFILE}" ]]; then
    fail "package-lock.json missing — commit it; it is the deterministic-install foundation"
else
    pass "package-lock.json present"
fi

# ── 3. Working tree clean (no uncommitted drift) ─────────────────────────
DIRTY="$(cd "${REPO_ROOT}" && git status --porcelain 2>/dev/null | grep -v '^?? ' || true)"
if [[ -n "${DIRTY}" ]]; then
    fail "working tree has uncommitted changes (modified/deleted tracked files):"
    echo "       ${DIRTY}" | head -5
else
    pass "working tree clean"
fi

# ── 4. Cockpit branch (dev) up to date with origin ───────────────────────
# The cockpit is the dev checkout: worktrees are cut from `dev`, so the
# freshness check targets dev's upstream (the old main-branch check predates
# the dev-branch flow).
CUR_BRANCH="$(cd "${REPO_ROOT}" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
if [[ "${CUR_BRANCH}" != "dev" ]]; then
    fail "cockpit not on 'dev' (on '${CUR_BRANCH}') — worktrees branch from an up-to-date dev"
else
    (cd "${REPO_ROOT}" && git fetch origin --quiet 2>/dev/null) || true
    LOCAL="$(cd "${REPO_ROOT}" && git rev-parse HEAD 2>/dev/null || echo '')"
    REMOTE="$(cd "${REPO_ROOT}" && git rev-parse @{u} 2>/dev/null || echo '')"
    if [[ -z "${REMOTE}" ]]; then
        fail "no upstream tracking branch configured for dev"
    elif [[ "${LOCAL}" != "${REMOTE}" ]]; then
        fail "dev is BEHIND origin — run 'git pull --rebase origin dev' first"
    else
        pass "dev up to date with origin"
    fi
fi

# ── Result ───────────────────────────────────────────────────────────────
echo ""
if [[ "${FAILED}" == "1" ]]; then
    echo "PRE-FLIGHT FAILED — fix the issues above in the COCKPIT (dev) checkout, then re-run."
    echo "Never create a worktree on a broken source of truth."
    exit 1
fi
echo "PRE-FLIGHT OK — safe to create a worktree."

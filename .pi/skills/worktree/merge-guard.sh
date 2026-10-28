#!/usr/bin/env bash
# merge-guard.sh — the mechanical merge gate: CI green, verdict present, reviewed head matches.
#
# Usage: merge-guard.sh <pr-number> <review-record-path> [--repo-root <path>]
#        merge-guard.sh --selftest
#
# Why (friction log 2026-10-27, `unreviewed final fix`): review round 2 on PR #395 returned
# changes-requested; the two-line fix was made directly, the gates were run, and the PR was
# merged with commit `77338bf` never seen by a reviewer. The disposition was defensible but it
# lived only in prose — nothing at the merge point could tell "reviewed head" from "a later
# commit". This script is that check: it refuses to clear a merge unless every one of these holds.
#
#   (a) `gh pr checks <pr>` reports no failing and no pending checks
#       (pass / skipping / neutral are fine; zero reported checks is NOT a pass)
#   (b) the review record mentions `#<pr>`
#   (c) the record's LAST `Verdict:` line says `approve` or `approve-with-nits`
#       (`changes-requested` may not merge; an unrecognised verdict may not either)
#   (d) the PR's CURRENT head sha appears in the record, OR the record carries a
#       `conductor-verified:` line — the documented disposition for a post-verdict commit
#       (a short sha of >= 7 hex chars counts; it must be a PREFIX of the head)
#   (e) `jev-check.mjs --log` passes for the local subagent log (Rule 22 dispatch audit) —
#       fail-closed: a missing/empty log is exit 2 and blocks the merge
#
# Run it from the COCKPIT (dev) checkout: the subagent log lives in the cockpit's local,
# gitignored `.pi/subagent-logs/`. `JEV_LOG` overrides the log path.
#
# Exit: 0 all checks pass · 1 at least one reason failed (every reason is listed) · 2 usage/input error.
#
# Record requirements the checks assume (see references/review-dispatch.md):
#   Reviewed head: <sha>        or  @ <sha>  anywhere in the record
#   Verdict: approve | approve-with-nits | changes-requested
#   conductor-verified: <sha> — <what was verified and how>   (post-verdict commit only)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
# Environment override wins over both the script location and --repo-root.
JEV_LOG_ENV="${JEV_LOG:-}"
JEV_LOG="${JEV_LOG_ENV:-${REPO_ROOT}/.pi/subagent-logs/brl-subagent.log}"

usage() {
    # Print the header block only (every leading comment, however long it grows).
    sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
}

# ── Record parsing (pure — no network; the selftest drives these directly) ──────────────

# (b) Does the record name this PR? `#39` must not match PR 395: require a non-digit after.
record_mentions_pr() {
    local record="$1" pr="$2"
    grep -qE "#${pr}([^0-9]|$)" "${record}"
}

# (c) The record's FINAL disposition: the leading token of the LAST `Verdict:` line.
# Markdown decorations (`**Verdict: approve**`, `## Verdict:`, backticks) are stripped. A line that
# names MORE than one verdict (an echoed template) is `ambiguous` — fail-closed, never a guess.
record_verdict() {
    local record="$1" line rest first lower have=""
    line="$(grep -iE 'Verdict:' "${record}" | tail -1 || true)"
    [[ -n "${line}" ]] || return 0
    rest="$(printf '%s' "${line}" | sed -E 's/.*[Vv][Ee][Rr][Dd][Ii][Cc][Tt]://')"
    lower="${rest,,}"
    [[ "${lower}" == *changes-requested* ]] && have+="c"
    [[ "${lower}" == *approve-with-nits* ]] && have+="n"
    [[ "${lower}" =~ (^|[^-a-z])approve([^-a-z]|$) ]] && have+="a"
    if [[ ${#have} -gt 1 ]]; then
        printf 'ambiguous'
        return 0
    fi
    first="$(printf '%s' "${rest}" | sed -E 's/^[^A-Za-z]*//')"
    [[ "${first}" =~ ^[A-Za-z][-A-Za-z]* ]] || return 0
    first="${first%%[!-A-Za-z]*}"
    printf '%s' "${first,,}"
}

# (d) Is the current head (or a >=7-char prefix of it) written in the record?
record_mentions_sha() {
    local record="$1" head="$2" token
    [[ -n "${head}" ]] || return 1
    grep -qiF -- "${head}" "${record}" && return 0
    while IFS= read -r token; do
        [[ ${#token} -ge 7 ]] || continue
        [[ "${head,,}" == "${token,,}"* ]] && return 0
    done < <(grep -oE '[0-9A-Fa-f]{7,40}' "${record}" || true)
    return 1
}

# (d, alternative disposition) The documented post-verdict-commit marker.
record_has_conductor_verified() {
    grep -qiE 'conductor-verified:' "$1"
}

# ── The gate ─────────────────────────────────────────────────────────────────────────────

FAIL_REASONS=()

pass_line() { printf '  ✓ %s\n' "$1"; }
fail_line() { printf '  ✗ %s\n' "$1"; FAIL_REASONS+=("$1"); }

check_ci() {
    local pr="$1" output rc=0 total=0 blocking=0 summary="" name status rest
    if ! command -v gh >/dev/null 2>&1; then
        fail_line "(a) CI: gh is not installed — cannot read the PR checks"
        return
    fi
    output="$(gh pr checks "${pr}" 2>&1)" || rc=$?
    while IFS=$'\t' read -r name status rest; do
        [[ -n "${name}" && -n "${status}" ]] || continue
        total=$((total + 1))
        summary+="${status} "
        case "${status,,}" in
            fail|cancel|cancelled|pending|queued|in_progress|error|timed_out|startup_failure|action_required)
                blocking=$((blocking + 1)) ;;
        esac
    done <<<"${output}"

    if [[ ${total} -eq 0 ]]; then
        # No parsable check rows is not a green CI — it is an unverifiable merge.
        fail_line "(a) CI: no checks reported by 'gh pr checks ${pr}' (gh exit ${rc}) — refusing to merge blind: ${output//$'\n'/ }"
        return
    fi
    if [[ ${blocking} -gt 0 ]]; then
        fail_line "(a) CI: ${blocking} of ${total} check(s) failing or pending — ${summary}"
        printf '%s\n' "${output}" | sed 's/^/      /'
        return
    fi
    pass_line "(a) CI: ${total} check(s), none failing or pending — ${summary}"
}

check_record() {
    local pr="$1" record="$2" head="$3" verdict

    # (b) PR number present.
    if record_mentions_pr "${record}" "${pr}"; then
        pass_line "(b) record names PR #${pr}"
    else
        fail_line "(b) the review record never mentions #${pr} — it is a verdict for some other PR (or none)"
    fi

    # (c) Verdict line.
    verdict="$(record_verdict "${record}")"
    case "${verdict}" in
        approve|approve-with-nits)
            pass_line "(c) verdict: ${verdict}" ;;
        changes-requested)
            fail_line "(c) verdict is changes-requested — the findings must be fixed and the head re-reviewed before merging" ;;
        "")
            fail_line "(c) the record has no 'Verdict:' line — a record without a disposition cannot clear a merge" ;;
        *)
            fail_line "(c) unrecognised verdict '${verdict}' — expected approve or approve-with-nits" ;;
    esac
    if [[ "${verdict}" == "ambiguous" ]]; then
        fail_line "(c) the record's last 'Verdict:' line names more than one verdict (an echoed template?) — state one disposition"
    fi

    # (d) Reviewed head (or the documented post-verdict disposition).
    if [[ -z "${head}" ]]; then
        fail_line "(d) could not read the PR head${HEAD_ERROR:+ — ${HEAD_ERROR}} — cannot tell whether the review covers it"
    elif record_mentions_sha "${record}" "${head}"; then
        pass_line "(d) reviewed head: ${head:0:12} appears in the record"
    elif record_has_conductor_verified "${record}"; then
        pass_line "(d) head ${head:0:12} is post-verdict — the record carries a 'conductor-verified:' line"
    else
        fail_line "(d) the PR head ${head:0:12} is not in the record and there is no 'conductor-verified:' line — the reviewed commit and the merge commit differ"
    fi
}

check_dispatch_audit() {
    local out rc=0
    if ! command -v node >/dev/null 2>&1; then
        fail_line "(e) dispatch audit: node is not installed — cannot run jev-check --log"
        return
    fi
    out="$(node "${SCRIPT_DIR}/jev-check.mjs" --log "${JEV_LOG}" 2>&1)" || rc=$?
    case "${rc}" in
        0) pass_line "(e) dispatch audit: jev-check --log green (${JEV_LOG})" ;;
        1)
            fail_line "(e) dispatch audit: a dispatch since the cutoff carries no valid Rule 22 line"
            printf '%s\n' "${out}" | sed 's/^/      /' ;;
        *)
            fail_line "(e) dispatch audit: jev-check --log could not run (exit ${rc}) — never a silent pass"
            printf '%s\n' "${out}" | sed 's/^/      /' ;;
    esac
}

# Set HEAD_SHA (the PR's current head) or HEAD_ERROR. Sets globals rather than printing so the
# failure detail survives for the reason list (a command substitution would swallow it).
HEAD_SHA=""
HEAD_ERROR=""
resolve_head_sha() {
    local pr="$1" out rc=0
    HEAD_SHA=""
    HEAD_ERROR=""
    if ! command -v gh >/dev/null 2>&1; then
        HEAD_ERROR="gh is not installed"
        return 1
    fi
    out="$(gh pr view "${pr}" --json headRefOid -q .headRefOid 2>&1)" || rc=$?
    if [[ ${rc} -ne 0 ]]; then
        HEAD_ERROR="'gh pr view ${pr} --json headRefOid' failed: ${out//$'\n'/ }"
        return 1
    fi
    HEAD_SHA="${out}"
    return 0
}

run_guard() {
    local pr="$1" record="$2"
    if ! [[ "${pr}" =~ ^[0-9]+$ ]]; then
        echo "merge-guard: <pr-number> must be numeric (got '${pr}')" >&2
        return 2
    fi
    if [[ ! -f "${record}" || ! -r "${record}" ]]; then
        echo "merge-guard: review record not readable: ${record}" >&2
        return 2
    fi

    echo "merge-guard: PR #${pr} · record ${record}"
    echo "             jev log ${JEV_LOG}"

    local head
    resolve_head_sha "${pr}" || true
    head="${HEAD_SHA}"

    check_ci "${pr}"
    check_record "${pr}" "${record}" "${head}"
    check_dispatch_audit

    if [[ ${#FAIL_REASONS[@]} -gt 0 ]]; then
        echo ""
        echo "MERGE BLOCKED — ${#FAIL_REASONS[@]} reason(s):"
        local i=1 reason
        for reason in "${FAIL_REASONS[@]}"; do
            echo "  ${i}. ${reason}"
            i=$((i + 1))
        done
        echo ""
        echo "merge-guard: fix the reasons above, re-review the new head, and re-run this guard."
        return 1
    fi

    echo ""
    echo "MERGE OK — PR #${pr} is clear to merge (merge commit to dev, never squash)."
    return 0
}

# ── Selftest — record-parsing fixtures (no gh, no network, no repo state) ───────────────

SELFTEST_PASS=0
SELFTEST_FAIL=0

expect_ok() {
    local label="$1"
    shift
    if "$@"; then
        printf '  ✓ %s\n' "${label}"
        SELFTEST_PASS=$((SELFTEST_PASS + 1))
    else
        printf '  ✗ %s (expected pass, got fail)\n' "${label}"
        SELFTEST_FAIL=$((SELFTEST_FAIL + 1))
    fi
}

expect_fail() {
    local label="$1"
    shift
    if "$@"; then
        printf '  ✗ %s (expected fail, got pass)\n' "${label}"
        SELFTEST_FAIL=$((SELFTEST_FAIL + 1))
    else
        printf '  ✓ %s\n' "${label}"
        SELFTEST_PASS=$((SELFTEST_PASS + 1))
    fi
}

expect_verdict() {
    local label="$1" record="$2" expected="$3" actual
    actual="$(record_verdict "${record}")"
    if [[ "${actual}" == "${expected}" ]]; then
        printf '  ✓ %s\n' "${label}"
        SELFTEST_PASS=$((SELFTEST_PASS + 1))
    else
        printf '  ✗ %s (expected %s, got %s)\n' "${label}" "${expected}" "${actual}"
        SELFTEST_FAIL=$((SELFTEST_FAIL + 1))
    fi
}

run_selftest() {
    local dir
    dir="$(mktemp -d)"
    # shellcheck disable=SC2064
    trap "rm -rf '${dir}'" EXIT

    local head="77338bffc929098cdcdf750a40933660edae6ed3"
    local other="04f41d0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

    cat >"${dir}/approve.md" <<EOF
# Review — PR #412

Reviewed head: ${head}

**Verdict: approve** — zero findings.
Merged in the worktree's review loop.
EOF

    cat >"${dir}/approve-nits.md" <<EOF
## Review of PR #412 @ ${head:0:7}

## Verdict: **approve-with-nits**

| Severity | Smell | file:line | One-liner |
|---|---|---|---|
| nit | oversized-function | a.ts:1 | split it later |
EOF

    cat >"${dir}/changes-requested.md" <<EOF
# Review — PR #412

Reviewed head: ${head}

**Verdict: changes-requested** — one major: the stream is truncated.
EOF

    cat >"${dir}/no-head.md" <<EOF
# Review — PR #412

**Verdict: approve** — but the record never names the commit it reviewed.
EOF

    cat >"${dir}/no-verdict.md" <<EOF
# Review — PR #412

Reviewed head: ${head}

No disposition was recorded (the reviewer's output was lost).
EOF

    cat >"${dir}/conductor-verified.md" <<EOF
# Review — PR #412

Reviewed head: ${other}

**Verdict: approve-with-nits**

Fixes applied after the verdict (two-line guard + two regression tests):
conductor-verified: tsc clean, suite 90/1798, mutation-proven guard.
EOF

    cat >"${dir}/wrong-pr.md" <<EOF
# Review — PR #400

Reviewed head: ${head}

**Verdict: approve**
EOF

    cat >"${dir}/template-echo.md" <<EOF
# Review — PR #412

Reviewed head: ${head}

Verdict: approve | approve-with-nits | changes-requested
EOF

    echo "merge-guard --selftest: record parsing"
    expect_ok "(b) names #412" record_mentions_pr "${dir}/approve.md" 412
    expect_fail "(b) #400 does not name #412" record_mentions_pr "${dir}/wrong-pr.md" 412
    expect_fail "(b) #41 must not match #412" record_mentions_pr "${dir}/approve.md" 41

    expect_verdict "(c) '**Verdict: approve**' parses as approve" "${dir}/approve.md" "approve"
    expect_verdict "(c) '## Verdict: **approve-with-nits**' parses as approve-with-nits" "${dir}/approve-nits.md" "approve-with-nits"
    expect_verdict "(c) changes-requested parses as changes-requested" "${dir}/changes-requested.md" "changes-requested"
    expect_verdict "(c) a record with no Verdict: line parses as empty" "${dir}/no-verdict.md" ""
    expect_verdict "(c) an echoed template is ambiguous (fail-closed)" "${dir}/template-echo.md" "ambiguous"

    expect_ok "(d) full head sha appears in the record" record_mentions_sha "${dir}/approve.md" "${head}"
    expect_ok "(d) a 7-char prefix counts as the head" record_mentions_sha "${dir}/approve-nits.md" "${head}"
    expect_fail "(d) a record with no sha does not cover the head" record_mentions_sha "${dir}/no-head.md" "${head}"
    expect_fail "(d) an unrelated sha does not cover the head" record_mentions_sha "${dir}/conductor-verified.md" "${head}"
    expect_ok "(d) 'conductor-verified:' is the post-verdict disposition" record_has_conductor_verified "${dir}/conductor-verified.md"
    expect_fail "(d) a plain record has no 'conductor-verified:' line" record_has_conductor_verified "${dir}/approve.md"

    # The full gate decision for the disposition case: (d) must clear via the marker.
    local gate_ok=true
    record_mentions_sha "${dir}/conductor-verified.md" "${head}" && gate_ok=false
    record_has_conductor_verified "${dir}/conductor-verified.md" || gate_ok=false
    if [[ "${gate_ok}" == "true" ]]; then
        printf '  ✓ (d) post-verdict commit clears through the conductor-verified: marker\n'
        SELFTEST_PASS=$((SELFTEST_PASS + 1))
    else
        printf '  ✗ (d) post-verdict commit does not clear through the conductor-verified: marker\n'
        SELFTEST_FAIL=$((SELFTEST_FAIL + 1))
    fi

    local total=$((SELFTEST_PASS + SELFTEST_FAIL))
    echo "merge-guard --selftest: ${SELFTEST_PASS}/${total} passed — $([[ ${SELFTEST_FAIL} -eq 0 ]] && echo PASS || echo FAIL)"
    [[ ${SELFTEST_FAIL} -eq 0 ]]
}

# ── CLI ─────────────────────────────────────────────────────────────────────────────────

main() {
    local args=() repo_root_override=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --selftest) run_selftest; return $? ;;
            -h|--help) usage; return 0 ;;
            --repo-root)
                [[ $# -ge 2 ]] || { echo "merge-guard: --repo-root needs a path" >&2; return 2; }
                repo_root_override="$2"
                shift 2 ;;
            *)
                args+=("$1")
                shift ;;
        esac
    done

    if [[ -n "${repo_root_override}" ]]; then
        REPO_ROOT="$(cd "${repo_root_override}" && pwd)"
    fi
    JEV_LOG="${JEV_LOG_ENV:-${REPO_ROOT}/.pi/subagent-logs/brl-subagent.log}"

    if [[ ${#args[@]} -ne 2 ]]; then
        echo "merge-guard: expected <pr-number> <review-record-path> (got ${#args[@]} argument(s))" >&2
        usage >&2
        return 2
    fi
    run_guard "${args[0]}" "${args[1]}"
}

main "$@"

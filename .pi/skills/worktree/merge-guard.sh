#!/usr/bin/env bash
# merge-guard.sh — the mechanical merge gate: CI green, verdict present, reviewed head matches.
#
# Usage: merge-guard.sh <pr-number> <review-record-path> [--repo-root <path>]
#        merge-guard.sh --check-record <record> [--pr <n>] [--head <sha>]
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
#   (f) the review record carries a `jev-recheck:` line (the classifier's answer on the DISPATCH
#       text, run at review time) and a `Risk class:` line; the recheck line must have its own
#       provenance row under the label `recheck-<pr>`, and the declared tier may not be weaker than
#       the recheck (C1 strongest). A record with only the dispatch-time line cannot show the tier
#       was right — the 2026-11-04 miss (dispatched C2, classified C1) is the case.
#   (e) `jev-check.mjs --log --require-provenance` passes for the local subagent log (Rule 22
#       dispatch audit + provenance) — fail-closed: a missing/empty log OR provenance log is
#       exit 2 and blocks the merge. Provenance is the Goodhart fix: a line in the right FORMAT
#       can be invented (2026-10-31: a dispatched `medium (0.70)` was really `high (0.32)`), so a
#       dispatch line must have a row written by `jev-check --classifier '<raw answers>' --label <name>`
#       (`--line --label` requires `--legacy-line`: format-only input cannot claim a classifier).
#
# Run it from the COCKPIT (dev) checkout: the subagent log lives in the cockpit's local,
# gitignored `.pi/subagent-logs/`. `JEV_LOG` overrides the log path.
#
# `--check-record` is the offline half: checks (b), (c), (d) and (f)'s field rules only, with no
# `gh`, no network and no provenance log — it runs `scripts/review-record.mjs --check`, which uses
# the same definition (`scripts/lib/record-fields.mjs`) that WRITES the record, so a generated
# record passing here and failing the gate cannot happen. `--pr` / `--head` are optional: pass them
# and the check also demands the record names that PR and covers that head; omit them for a
# shape-only check. (a) CI, (e) the dispatch audit and (f)'s `recheck-<pr>` row stay in the full
# gate — none of them can be answered offline.
#
# Exit: 0 all checks pass · 1 at least one reason failed (every reason is listed) · 2 usage/input error.
#
# Record requirements the checks assume (see references/review-dispatch.md). Write the record with
# `scripts/review-record.mjs` — it emits exactly this block; do not transcribe it by hand:
#   Reviewed head: <sha>        or  @ <sha>  anywhere in the record
#   Verdict: approve | approve-with-nits | changes-requested
#   conductor-verified: <sha> — <what was verified and how>   (post-verdict commit only)
#   jev-recheck: jev: <level> (<conf>) · Cx · worktree <y|n>   (produced by --classifier, label recheck-<pr>)
#   Risk class: C1 | C2 | C3

# The provenance log for (f) — override with JEV_PROVENANCE (used by the selftest).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
# Environment override wins over both the script location and --repo-root.
JEV_LOG_ENV="${JEV_LOG:-}"
JEV_LOG="${JEV_LOG_ENV:-${REPO_ROOT}/.pi/subagent-logs/brl-subagent.log}"
JEV_PROVENANCE_ENV="${JEV_PROVENANCE:-}"
JEV_PROVENANCE="${JEV_PROVENANCE_ENV:-${REPO_ROOT}/.pi/jev-lines.log}"

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
    local record="$1" line="" rest first lower have="" raw stripped in_fence=0
    # A disposition is a LINE-START `Verdict:` outside a fenced code block: markdown
    # decoration (spaces, #, *, backticks) is stripped first, then the prefix must be
    # `Verdict:`. Prose mentions ("the `Verdict:` line says…") and fenced examples are
    # inert — the previous any-line/tail-1 rule made every record that *documents* the
    # gate block itself (PR #397 once, PR #399 twice).
    local fence='^[[:space:]]*(```|~~~)'
    while IFS= read -r raw; do
        if [[ "${raw}" =~ ${fence} ]]; then
            in_fence=$((in_fence ? 0 : 1))
            continue
        fi
        [[ ${in_fence} -eq 1 ]] && continue
        stripped="$(printf '%s' "${raw}" | sed -E 's/^[[:space:]#*`]+//')"
        case "${stripped,,}" in
            verdict:*) line="${stripped}" ;;
        esac
    done < "${record}"
    [[ -n "${line}" ]] || return 0
    rest="$(printf '%s' "${line}" | sed -E 's/^[Vv][Ee][Rr][Dd][Ii][Cc][Tt]://')"
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

# (f) A line-start `<label>:` value outside fences — the last one wins, markdown stripped.
record_line_field() {
    local record="$1" label="$2" line="" raw stripped in_fence=0
    local fence='^[[:space:]]*(```|~~~)'
    while IFS= read -r raw; do
        if [[ "${raw}" =~ ${fence} ]]; then
            in_fence=$((in_fence ^ 1))
            continue
        fi
        [[ ${in_fence} -eq 1 ]] && continue
        stripped="$(printf '%s' "${raw}" | sed -E 's/^[[:space:]#*`]+//')"
        if [[ "${stripped,,}" == "${label,,}"* ]]; then
            line="${stripped#*:}"
            line="$(printf '%s' "${line}" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
        fi
    done < "${record}"
    printf '%s' "${line}"
}

record_recheck() { record_line_field "$1" "jev-recheck:"; }
record_risk() { record_line_field "$1" "Risk class:"; }

RE_RECHECK='^jev: (off|minimal|low|medium|high|xhigh) \([01](\.[0-9]+)?\) · C[123] · worktree [yn]$'

risk_rank() {
    case "${1^^}" in
        C1) printf '3' ;;
        C2) printf '2' ;;
        C3) printf '1' ;;
        *) printf '0' ;;
    esac
}

# The recheck line must have a provenance row labelled `recheck-<pr>` — a dispatch-time row is
# not enough (that line belongs to the dispatch, not to the review-time classification).
provenance_has_recheck() {
    local line="$1" pr="$2"
    [[ -n "${line}" && -f "${JEV_PROVENANCE}" ]] || return 1
    awk -F'\t' -v want="${line}" -v label="recheck-${pr}" '
        NF >= 3 && $2 == label && $3 == want { found = 1 }
        END { exit(found ? 0 : 1) }
    ' "${JEV_PROVENANCE}"
}

# Empty when the record satisfies (f); otherwise the reason.
recheck_decision() {
    local pr="$1" record="$2" line risk recheck_risk declared_rank recheck_rank
    line="$(record_recheck "${record}")"
    if [[ -z "${line}" ]]; then
        printf 'the record has no line-start "jev-recheck:" — run the classifier on the DISPATCH text at review time'
        return
    fi
    if ! [[ "${line}" =~ ${RE_RECHECK} ]]; then
        printf 'malformed jev-recheck line %s — expected "jev-recheck: jev: <level> (<conf>) · Cx · worktree <y|n>"' "${line@Q}"
        return
    fi
    risk="$(record_risk "${record}")"
    if ! [[ "${risk^^}" =~ ^C[123]$ ]]; then
        printf 'the record has no "Risk class: C1|C2|C3" line — the review tier must be stated next to the recheck'
        return
    fi
    if ! provenance_has_recheck "${line}" "${pr}"; then
        printf 'no provenance row "%s" for the recheck — print it with: jev-check --classifier '"'"'<raw answers>'"'"' --label recheck-%s' "${line}" "${pr}"
        return
    fi
    local stripped="${line% · worktree *}"
    recheck_risk="${stripped##*· }"
    declared_rank="$(risk_rank "${risk}")"
    recheck_rank="$(risk_rank "${recheck_risk}")"
    if [[ ${declared_rank} -lt ${recheck_rank} ]]; then
        printf 'the record declares Risk class %s but the recheck classified %s — the review depth understates the risk' "${risk^^}" "${recheck_risk}"
        return
    fi
}

check_recheck() {
    local pr="$1" record="$2" reason
    reason="$(recheck_decision "${pr}" "${record}")"
    if [[ -z "${reason}" ]]; then
        pass_line "(f) recheck: $(record_recheck "${record}") · declared $(record_risk "${record}")"
    else
        fail_line "(f) recheck: ${reason}"
    fi
}

# ── --check-record — the offline half, from the SAME definition that writes the record ──

# Delegate to `scripts/review-record.mjs --check`, which uses `scripts/lib/record-fields.mjs` — one
# definition, so a record the generator emits passing here and failing the gate on a field rule is
# not possible. No `gh`, no network, no provenance log: (a), (e) and (f)'s `recheck-<pr>` row need
# the full gate. `pr` / `head` are optional (shape-only check); pass them to demand both.
run_record_check() {
    local record="$1" pr="$2" head="$3"
    local tool="${REPO_ROOT}/scripts/review-record.mjs"
    if [[ ! -f "${tool}" ]]; then
        echo "merge-guard: ${tool} is missing — a checkout older than #487 cannot check a record" >&2
        return 2
    fi
    if ! command -v node >/dev/null 2>&1; then
        echo "merge-guard: node is not installed — cannot run the record check" >&2
        return 2
    fi
    if [[ ! -f "${record}" || ! -r "${record}" ]]; then
        echo "merge-guard: review record not readable: ${record}" >&2
        return 2
    fi
    local args=(--check "${record}")
    if [[ -n "${pr}" ]]; then
        args+=(--pr "${pr}")
    fi
    if [[ -n "${head}" ]]; then
        args+=(--head "${head}")
    fi
    node "${tool}" "${args[@]}"
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
            fail_line "(c) the record has no line-start 'Verdict:' disposition (outside fences) — a record without one cannot clear a merge" ;;
        *)
            fail_line "(c) unrecognised verdict '${verdict}' — expected approve or approve-with-nits" ;;
    esac
    if [[ "${verdict}" == "ambiguous" ]]; then
        fail_line "(c) the record's last line-start disposition names more than one verdict (an echoed template?) — state one disposition"
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
    out="$(node "${SCRIPT_DIR}/jev-check.mjs" --log "${JEV_LOG}" --require-provenance 2>&1)" || rc=$?
    case "${rc}" in
        0) pass_line "(e) dispatch audit: jev-check --log --require-provenance green (${JEV_LOG})" ;;
        1)
            fail_line "(e) dispatch audit: a dispatch since the cutoff carries no valid Rule 22 line or no provenance row"
            printf '%s\n' "${out}" | sed 's/^/      /' ;;
        *)
            fail_line "(e) dispatch audit: jev-check --log could not run (exit ${rc}) — never a silent pass. A missing provenance log means no dispatch line was ever printed by \`--classifier --label\`; run it for every dispatch since the cutoff."
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
    check_recheck "${pr}" "${record}"

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

    cat >"${dir}/prose-mention.md" <<EOF
# Review — PR #412

Reviewed head: ${head}

**Verdict: approve** — zero findings.

Notes: the record-contract table's machine-checked rows are untouched; the new section
introduces no \`Verdict:\` line and no head sha. A later sentence mentioning Verdict: inline must not win.
EOF

    cat >"${dir}/fenced-example.md" <<EOF
# Review — PR #412

Reviewed head: ${head}

**Verdict: approve** — zero findings.

The required format is:

~~~md
Verdict: changes-requested
~~~

(the fenced example above is documentation, not the disposition)
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
    expect_verdict "(c) a prose mention after the disposition is inert" "${dir}/prose-mention.md" "approve"
    expect_verdict "(c) a fenced example after the disposition is inert" "${dir}/fenced-example.md" "approve"

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

    # --- (f) classifier recheck -------------------------------------------
    local prov="${dir}/jev-lines.log"
    printf '2026-11-04T00:00:00.000Z\timpl-423\tjev: medium (0.72) · C2 · worktree y\n' >"${prov}"
    printf '2026-11-04T00:00:01.000Z\trecheck-412\tjev: medium (0.63) · C1 · worktree y\n' >>"${prov}"
    JEV_PROVENANCE="${prov}"

    cat >"${dir}/recheck-ok.md" <<EOF
# Review — PR #412

Reviewed head: ${head}

Verdict: approve

jev-recheck: jev: medium (0.63) · C1 · worktree y
Risk class: C1
EOF

    cat >"${dir}/recheck-weak.md" <<EOF
# Review — PR #412

Verdict: approve

jev-recheck: jev: medium (0.63) · C1 · worktree y
Risk class: C2
EOF

    cat >"${dir}/recheck-missing.md" <<EOF
# Review — PR #412

Verdict: approve

Risk class: C1
EOF

    cat >"${dir}/recheck-malformed.md" <<EOF
# Review — PR #412

Verdict: approve

jev-recheck: medium · C1
Risk class: C1
EOF

    cat >"${dir}/recheck-unproven.md" <<EOF
# Review — PR #412

Verdict: approve

jev-recheck: jev: high (0.44) · C1 · worktree y
Risk class: C1
EOF

    # #468 B pin: the LEVEL is an observation. A recheck whose level sits BELOW the dispatch's
    # level must still clear when the RISK class is equal — check (f) compares risk ranks, never
    # level adequacy, so a dispatch classified `high` and rechecked `minimal` at the same C1 is
    # not a finding. A guard that started reading the level would fail this case.
    printf '2026-11-04T00:00:02.000Z\timpl-412\tjev: high (0.72) · C1 · worktree y\n' >>"${prov}"
    printf '2026-11-04T00:00:03.000Z\trecheck-level-drop\tjev: minimal (0.58) · C1 · worktree y\n' >>"${prov}"

    cat >"${dir}/recheck-level-below.md" <<EOF
# Review — PR #level-drop

Verdict: approve

jev-recheck: jev: minimal (0.58) · C1 · worktree y
Risk class: C1
EOF

    check_f_ok() {
        local label="$1" record="$2" expected="$3" pr="${4:-412}" reason
        reason="$(recheck_decision "${pr}" "${record}")"
        if [[ -z "${expected}" ]]; then
            if [[ -z "${reason}" ]]; then
                printf '  ✓ %s\n' "${label}"
                SELFTEST_PASS=$((SELFTEST_PASS + 1))
            else
                printf '  ✗ %s (expected pass, got: %s)\n' "${label}" "${reason}"
                SELFTEST_FAIL=$((SELFTEST_FAIL + 1))
            fi
        elif [[ "${reason}" == *"${expected}"* ]]; then
            printf '  ✓ %s\n' "${label}"
            SELFTEST_PASS=$((SELFTEST_PASS + 1))
        else
            printf '  ✗ %s (expected reason containing %s, got: %s)\n' "${label}" "${expected}" "${reason}"
            SELFTEST_FAIL=$((SELFTEST_FAIL + 1))
        fi
    }

    check_f_ok "(f) a rechecked, provenance-bound record at the classified tier passes" "${dir}/recheck-ok.md" ""
    check_f_ok "(f) a declared tier weaker than the recheck fails" "${dir}/recheck-weak.md" "understates the risk"
    check_f_ok "(f) a record without jev-recheck fails" "${dir}/recheck-missing.md" "no line-start"
    check_f_ok "(f) a malformed recheck fails" "${dir}/recheck-malformed.md" "malformed"
    check_f_ok "(f) a recheck line with no provenance row fails" "${dir}/recheck-unproven.md" "no provenance row"
    # #468 B pin — the level is an observation: a recheck BELOW the dispatch's level passes when
    # the risk class is equal (the guard reads the risk, never the level).
    check_f_ok "(f) a recheck LEVEL below the dispatch level passes when the risk class is equal (#468)" "${dir}/recheck-level-below.md" "" "level-drop"

    # --- --check-record: the offline mode is the generator's own definition ----------------
    # Quiet helpers: the node tool's own report is covered by scripts/__tests__/review-record.test.ts;
    # here the point is only that the mode exists and agrees with the generator.
    check_record_ok() { run_record_check "$1" "$2" "$3" >/dev/null 2>&1; }

    cat >"${dir}/written-by-the-generator.md" <<EOF
# Review record — PR #412

Reviewed head: ${head}
Verdict: approve-with-nits
Risk class: C1
jev-recheck: jev: medium (0.63) · C1 · worktree y

## Findings

No findings recorded.
EOF

    expect_ok "--check-record accepts a well-formed record" check_record_ok "${dir}/written-by-the-generator.md" 412 "${head}"
    expect_fail "--check-record rejects a malformed recheck" check_record_ok "${dir}/recheck-malformed.md" 412 ""
    expect_fail "--check-record rejects a declared tier weaker than the recheck" check_record_ok "${dir}/recheck-weak.md" 412 ""
    expect_fail "--check-record rejects a record that does not cover the head" check_record_ok "${dir}/written-by-the-generator.md" 412 "${other}"

    local total=$((SELFTEST_PASS + SELFTEST_FAIL))
    echo "merge-guard --selftest: ${SELFTEST_PASS}/${total} passed — $([[ ${SELFTEST_FAIL} -eq 0 ]] && echo PASS || echo FAIL)"
    [[ ${SELFTEST_FAIL} -eq 0 ]]
}

# ── CLI ─────────────────────────────────────────────────────────────────────────────────

main() {
    local args=() repo_root_override="" check_record_path="" check_pr="" check_head=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --selftest) run_selftest; return $? ;;
            -h|--help) usage; return 0 ;;
            --repo-root)
                [[ $# -ge 2 ]] || { echo "merge-guard: --repo-root needs a path" >&2; return 2; }
                repo_root_override="$2"
                shift 2 ;;
            --check-record)
                [[ $# -ge 2 ]] || { echo "merge-guard: --check-record needs a record path" >&2; return 2; }
                check_record_path="$2"
                shift 2 ;;
            --pr)
                [[ $# -ge 2 ]] || { echo "merge-guard: --pr needs a PR number" >&2; return 2; }
                check_pr="$2"
                shift 2 ;;
            --head)
                [[ $# -ge 2 ]] || { echo "merge-guard: --head needs a sha" >&2; return 2; }
                check_head="$2"
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
    JEV_PROVENANCE="${JEV_PROVENANCE_ENV:-${REPO_ROOT}/.pi/jev-lines.log}"

    # `--check-record` is a mode, not a third positional: it never reaches the network.
    if [[ -n "${check_record_path}" ]]; then
        run_record_check "${check_record_path}" "${check_pr}" "${check_head}"
        return $?
    fi

    if [[ ${#args[@]} -ne 2 ]]; then
        echo "merge-guard: expected <pr-number> <review-record-path> (got ${#args[@]} argument(s))" >&2
        usage >&2
        return 2
    fi
    run_guard "${args[0]}" "${args[1]}"
}

main "$@"

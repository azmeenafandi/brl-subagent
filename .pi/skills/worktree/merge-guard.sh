#!/usr/bin/env bash
# merge-guard.sh — the mechanical merge gate: CI green, verdict present, reviewed head matches.
#
# Usage: merge-guard.sh <pr-number> <review-record-path> [--repo-root <path>] [--pr-tree <path>]
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
#   (g) TWO HALVES, both run on EVERY PR.
#
#       (i) THE TEST-BUDGET FLOW (policy v2). `check-test-budget.mjs --flow --base dev --head <sha>`
#       measures THIS PR's net test:source delta, so the gate judges what the PR spends rather than
#       the tree's stock ratio. The tool is ALWAYS the cockpit's copy (`$REPO_ROOT/scripts/…`),
#       never the PR tree's: a PR must not be able to change the rule that judges it. A `within`
#       flow passes; an `over` flow needs a line-start `Test budget: <reason>` in the body outside
#       fences, blockquotes and the `<!-- pr-evidence:begin -->` block — absent is
#       `test-flow-undeclared` (blocked), present is `test-flow-override` (passed, with the line
#       echoed). An unanswerable flow (exit 2: `unknown-head`, `already-merged`, `diff-failed`)
#       blocks with that named reason — "cannot measure" is never a pass.
#
#       (ii) THE PR BODY'S NUMBERS are recomputed (#500): `pr-evidence --check --pr <n>` runs here,
#       not in the conductor's head, against a checkout whose HEAD is the PR head. The block half
#       is only applicable when the body carries a `<!-- pr-evidence:begin -->` block or states a
#       count (the tool's own predicate — its fenced block and blockquote exemptions stay);
#       otherwise it says there is nothing to recompute. A drift blocks with the tool's named code,
#       and an unanswerable run (exit 2) blocks too. The body's TEXT is only ever handed to the
#       tools' pure parsers; nothing read from a PR body is executed.
#
# Run it from the COCKPIT (dev) checkout: the subagent log lives in the cockpit's local,
# gitignored `.pi/subagent-logs/`. `JEV_LOG` overrides the log path.
#
# Paths and identity (#500). Both arguments are resolved and echoed at the top of the run (`pr`,
# `record` absolute) and every open/read error names the RESOLVED path: a relative record path is
# resolved against the caller's cwd, so `merge-guard.sh 500 REVIEW_PR500.md` works from the cockpit.
# The header also carries `record sha256: <hash>` — the bytes the gate read, so the conductor can
# confirm they are the bytes the reviewer produced (a transcribed record once passed a claim about a
# file the gate never saw).
#
# Check (g)'s BLOCK half measures the PR's head, and suite/budget are read from a CHECKED-OUT TREE,
# so the tool runs the copy of `scripts/pr-evidence.mjs` that lives in a checkout whose HEAD is the
# PR's head (`git worktree list` finds it; the review worktree normally is). `--pr-tree <path>` names
# it explicitly. With neither, the block half blocks and says how to provide one — a body checked
# against the wrong tree would be a confident wrong answer, which is exactly what the tool refuses
# to give. The FLOW half needs no checkout at all: it reads git (`git diff <base>...<head>`), and it
# runs the COCKPIT's `scripts/check-test-budget.mjs` — never the PR tree's, so a PR cannot ship the
# rule that judges it.
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

# ── Paths and identity (#500) ─────────────────────────────────────────────────────────

# The caller's cwd is the base for a relative path — never the script's location and never
# REPO_ROOT: a record is an argument, so it resolves where the caller stood (which is how
# `merge-guard.sh 500 REVIEW_PR500.md` works from the cockpit and the same relative path works
# nowhere else, said out loud instead of failing with a shell `cat: no such file`).
absolute_path() {
    local path="$1" dir base
    [[ -n "${path}" ]] || return 1
    case "${path}" in
        /*) dir="$(dirname "${path}")" ;;
        *) dir="$(dirname "${PWD}/${path}")" ;;
    esac
    base="$(basename "${path}")"
    if [[ -d "${dir}" ]]; then
        printf '%s/%s' "$(cd "${dir}" && pwd -P)" "${base}"
    else
        printf '%s/%s' "${dir}" "${base}"
    fi
}

# The bytes the gate read, so the conductor can confirm they are the bytes the reviewer produced
# (#500: a reviewer once transcribed its record, left no file and claimed --check-record passed).
record_sha256() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    else
        return 1
    fi
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

# ── Check (g) — the flow rule and the PR body's numbers ────────────────────────────────────

# (g) is TWO halves and BOTH run on every PR: the flow rule (this PR's net test delta) and the
# body's five-key block recompute (#500). Neither half can return early for the other: an
# over-allowance PR with a stale block must report both reasons.
check_pr_evidence() {
    check_test_flow "$1"
    check_pr_evidence_block "$1"
}

# Both seams the selftest replaces, because (g) is otherwise a `gh` read plus a subprocess:
#   PR_EVIDENCE_BODY_FILE  a body file on disk instead of `gh pr view <n> --json body`
#   PR_EVIDENCE_CMD        the tool invocation instead of the PR tree's own pr-evidence.mjs
# The defaults are the real thing; the selftest never reaches the network. A THIRD seam,
# TEST_FLOW_CMD, replaces only the flow tool's invocation (its declaration scan stays the real one,
# so the body fixtures are judged by the shipped parser).
PR_EVIDENCE_BODY_FILE=""
PR_EVIDENCE_CMD=()
TEST_FLOW_CMD=()

# The PR body, from the fixture file the selftest supplies or from `gh`. A failed read is the
# caller's to name; this helper only forwards bytes (or `gh`'s status) to stdin.
read_pr_body() {
    local pr="$1"
    if [[ -n "${PR_EVIDENCE_BODY_FILE}" ]]; then
        cat "${PR_EVIDENCE_BODY_FILE}"
    else
        gh pr view "${pr}" --json body -q .body
    fi
}

# The flow tool: ALWAYS the cockpit copy at REPO_ROOT — never anything under the PR tree. That is
# the whole point of the seam: `scripts/check-test-budget.mjs` is the rule, and a PR cannot ship a
# changed rule that judges itself. `--flow` reads git only, so the head need not be checked out.
check_test_flow() {
    local pr="$1" out rc=0 line reason rc_decl=0 declaration=""
    local tool="${REPO_ROOT}/scripts/check-test-budget.mjs"
    local -a cmd=(node "${tool}")
    if [[ ${#TEST_FLOW_CMD[@]} -gt 0 ]]; then cmd=("${TEST_FLOW_CMD[@]}"); fi
    if [[ -z "${HEAD_SHA}" ]]; then
        fail_line "(g) test-flow: unknown-head — the PR head could not be resolved${HEAD_ERROR:+ (${HEAD_ERROR})}; the flow cannot be measured"
        return
    fi

    out="$( cd "${REPO_ROOT}" && "${cmd[@]}" --flow --base dev --head "${HEAD_SHA}" 2>&1 )" || rc=$?
    # The contract line (or the named refusal) is the LAST line the tool printed: a usage error
    # prefixes the USAGE block, and every other path prints exactly one `test-flow: …` line.
    line="${out##*$'\n'}"
    line="${line#test-flow: }"
    case "${rc}" in
        0)
            pass_line "(g) test-flow: ${line} — measured by the cockpit copy" ;;
        1)
            # Over-allowance: the body must CARRY the decision, judged by the same fence/blockquote/
            # pr-evidence-aware scanner the tool ships (a fenced or quoted "Test budget:" is how a
            # body DOCUMENTS the format, not how it authorises a spend).
            declaration="$(read_pr_body "${pr}" | node "${tool}" --declaration 2>/dev/null)" || rc_decl=$?
            if [[ ${rc_decl} -eq 0 && -n "${declaration}" ]]; then
                pass_line "(g) test-flow: test-flow-override — ${line}; declared: ${declaration}"
            else
                fail_line "(g) test-flow: test-flow-undeclared — ${line}; add a line-start 'Test budget: <reason>' outside fences, blockquotes and the pr-evidence block to accept it"
            fi ;;
        *)
            reason="${line}"
            [[ -n "${reason}" ]] || reason="the tool exited ${rc} with no output"
            fail_line "(g) test-flow: ${reason} (the flow could not be measured; fail closed)" ;;
    esac
}

# Applicability, decided by the tool's OWN predicate: a block, or a count outside one (its fenced
# block and blockquote exemptions included). Duplicating that regex here would be a second definition
# of "the body states a number", so the pure module is imported and only a PATH travels in argv —
# the body's text is parsed, never executed.
PR_EVIDENCE_PREDICATE='
import { readFileSync } from "node:fs";
const { scanBlocks, unattributedCounts } = await import(process.argv[1]);
const lines = readFileSync(0, "utf8").split("\n");
const { ranges, unclosed } = scanBlocks(lines);
const applicable = ranges.length > 0 || unclosed !== -1 || unattributedCounts(lines, ranges).length > 0;
console.log(applicable ? "applicable" : "not applicable");
'

# Sets PR_TREE — a checkout whose HEAD is the PR head, which is the only tree (g) may measure — or
# PR_TREE_ERROR. `--pr-tree` wins; otherwise the repo's own worktree list answers, and a miss is a
# named failure rather than a check against the cockpit's tree (that would answer about the wrong
# bytes: the tool refuses it, and so does this).
PR_TREE=""
PR_TREE_ERROR=""
resolve_pr_tree() {
    local pr="$1" head="$2" path="" sha="" line
    PR_TREE=""
    PR_TREE_ERROR=""
    if [[ -n "${PR_TREE_OVERRIDE}" ]]; then
        PR_TREE="$(absolute_path "${PR_TREE_OVERRIDE}")"
        if [[ ! -f "${PR_TREE}/scripts/pr-evidence.mjs" ]]; then
            PR_TREE_ERROR="--pr-tree ${PR_TREE} has no scripts/pr-evidence.mjs"
            PR_TREE=""
            return 1
        fi
        return 0
    fi
    if [[ -z "${head}" ]]; then
        PR_TREE_ERROR="the PR head is unknown — cannot tell which tree the body's numbers describe"
        return 1
    fi
    while IFS= read -r line; do
        case "${line}" in
            worktree\ *) path="${line#worktree }" ;;
            HEAD\ *) sha="${line#HEAD }" ;;
            "")
                if [[ -n "${path}" && "${sha}" == "${head}" && -f "${path}/scripts/pr-evidence.mjs" ]]; then
                    PR_TREE="${path}"
                    return 0
                fi
                path=""
                sha=""
                ;;
        esac
    done < <(git -C "${REPO_ROOT}" worktree list --porcelain 2>/dev/null; echo)
    PR_TREE_ERROR="no local checkout has PR #${pr}'s head ${head} — provision one (git worktree add <path> ${head}) or pass --pr-tree <path>"
    return 1
}

# The tool's findings, as its named codes. A finding is `pr-evidence: <code> (line N): …` or
# `pr-evidence: <code>: …`; the tool's other chatter (`suite/budget read from …`, `out of scope by
# design: …`, `clean — …`) has no code in that position, so it is not mistaken for one.
pr_evidence_codes() {
    sed -nE 's/^pr-evidence: ([a-z-]+)( \(line [0-9]+\))?: .*/\1/p' | paste -sd, -
}

check_pr_evidence_block() {
    local pr="$1" verdict out rc=0 codes tree_label

    if ! verdict="$(
        read_pr_body "${pr}" \
            | node --input-type=module -e "${PR_EVIDENCE_PREDICATE}" "${REPO_ROOT}/scripts/lib/pr-evidence.mjs"
    )"; then
        fail_line "(g) pr-evidence: could not read PR #${pr}'s body or the tool's own predicate (${REPO_ROOT}/scripts/lib/pr-evidence.mjs) — refusing to skip"
        return
    fi
    case "${verdict}" in
        "not applicable")
            # The body states no count and carries no block: there is nothing to recompute. This is
            # a skip of the BLOCK half only — (g) itself already ran the flow half, and a skip
            # never clears anything.
            skip_line "(g) pr-evidence: the body states no counts and no block — nothing to recompute (the flow half above is the gate)"
            return ;;
        applicable) ;;
        *)
            fail_line "(g) pr-evidence: the applicability predicate printed ${verdict@Q} — expected 'applicable' or 'not applicable'"
            return ;;
    esac

    local -a cmd=()
    if [[ ${#PR_EVIDENCE_CMD[@]} -gt 0 ]]; then
        cmd=("${PR_EVIDENCE_CMD[@]}")
        tree_label="the configured tool"
    else
        if ! resolve_pr_tree "${pr}" "${HEAD_SHA}"; then
            fail_line "(g) pr-evidence: ${PR_TREE_ERROR}"
            return
        fi
        cmd=(node "${PR_TREE}/scripts/pr-evidence.mjs")
        tree_label="${PR_TREE}"
    fi

    out="$("${cmd[@]}" --check --pr "${pr}" 2>&1)" || rc=$?
    case "${rc}" in
        0)
            pass_line "(g) pr-evidence: the body's block recomputes clean at PR #${pr}'s head (${tree_label})" ;;
        *)
            codes="$(printf '%s\n' "${out}" | pr_evidence_codes)"
            fail_line "(g) pr-evidence: --check --pr ${pr} exited ${rc}${codes:+ — ${codes}} (${tree_label}); the body's numbers are stale or unattributed"
            printf '%s\n' "${out}" | sed 's/^/      /' ;;
    esac
}

# ── --check-record — the offline half, from the SAME definition that writes the record ──

# Delegate to `scripts/review-record.mjs --check`, which uses `scripts/lib/record-fields.mjs` — one
# definition, so a record the generator emits passing here and failing the gate on a field rule is
# not possible. No `gh`, no network, no provenance log: (a), (e) and (f)'s `recheck-<pr>` row need
# the full gate. `pr` / `head` are optional (shape-only check); pass them to demand both.
run_record_check() {
    local record="$(absolute_path "$1")" pr="$2" head="$3"
    local tool="${REPO_ROOT}/scripts/review-record.mjs"
    if [[ ! -f "${tool}" ]]; then
        echo "merge-guard: ${tool} is missing — a checkout older than #487 cannot check a record" >&2
        return 2
    fi
    if ! command -v node >/dev/null 2>&1; then
        echo "merge-guard: node is not installed — cannot run the record check (record: ${record})" >&2
        return 2
    fi
    if [[ ! -f "${record}" ]]; then
        echo "merge-guard: record: ${record} — not found" >&2
        return 2
    fi
    if [[ ! -r "${record}" ]]; then
        echo "merge-guard: record: ${record} — not readable" >&2
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
# A SKIP is not a pass: nothing was checked, so it never clears anything either — it just says why
# the check did not apply (check (g) on a docs-only body).
skip_line() { printf '  · %s\n' "$1"; }

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
        # A HINT, never a pass: a PR that cannot merge (a conflict, a draft, a fork whose
        # workflows need approval) reports no checks at all, so name the likely cause (#465).
        fail_line "(a) CI: no checks reported by 'gh pr checks ${pr}' (gh exit ${rc}) — refusing to merge blind: ${output//$'\n'/ }"
        printf '      may mean the PR cannot merge (#465): `gh pr view %s --json mergeable,mergeStateStatus`\n' "${pr}"
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
    local pr="$1" record hash
    if ! [[ "${pr}" =~ ^[0-9]+$ ]]; then
        echo "merge-guard: <pr-number> must be numeric (got '${pr}')" >&2
        return 2
    fi
    # Resolve BOTH arguments before anything else, and name the resolved path in every refusal: a
    # missing record must read as `record: /abs/path — not found`, never as a shell error.
    record="$(absolute_path "$2")"
    if [[ ! -f "${record}" ]]; then
        echo "merge-guard: record: ${record} — not found (resolved from ${2@Q} against ${PWD})" >&2
        return 2
    fi
    if [[ ! -r "${record}" ]]; then
        echo "merge-guard: record: ${record} — not readable" >&2
        return 2
    fi
    if ! hash="$(record_sha256 "${record}")"; then
        echo "merge-guard: record sha256: neither sha256sum nor shasum is installed — cannot confirm the gate read the reviewer's bytes" >&2
        return 2
    fi

    echo "merge-guard: pr #${pr}"
    echo "             record ${record}"
    echo "             record sha256: ${hash}"
    echo "             jev log ${JEV_LOG}"

    local head
    resolve_head_sha "${pr}" || true
    head="${HEAD_SHA}"

    check_ci "${pr}"
    check_record "${pr}" "${record}" "${head}"
    check_dispatch_audit
    check_recheck "${pr}" "${record}"
    check_pr_evidence "${pr}"

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

# Run a command and assert BOTH its exit code and a substring of its output — the only way to test a
# refusal that must also NAME the path it resolved. The command runs in a subshell, so a case cannot
# leak state into the next one.
expect_run() {
    local label="$1" want_rc="$2" want_text="$3"
    shift 3
    local out="" rc=0
    if out="$("$@" 2>&1)"; then rc=0; else rc=$?; fi
    if [[ "${rc}" -ne "${want_rc}" ]]; then
        printf '  ✗ %s (expected exit %s, got %s: %s)\n' "${label}" "${want_rc}" "${rc}" "${out//$'\n'/ }"
        SELFTEST_FAIL=$((SELFTEST_FAIL + 1))
    elif [[ -n "${want_text}" && "${out}" != *"${want_text}"* ]]; then
        printf '  ✗ %s (expected output containing %s, got: %s)\n' "${label}" "${want_text}" "${out//$'\n'/ }"
        SELFTEST_FAIL=$((SELFTEST_FAIL + 1))
    else
        printf '  ✓ %s\n' "${label}"
        SELFTEST_PASS=$((SELFTEST_PASS + 1))
    fi
}

# Run a command with a caller cwd that is not the repo — the relative-record-path cases (#500).
in_dir() {
    local dir="$1"
    shift
    ( cd "${dir}" && "$@" )
}

# One line of an ad-hoc assertion, so a case that needs two facts does not get a bespoke block.
expect_that() {
    local label="$1"
    shift
    if "$@"; then
        printf '  ✓ %s\n' "${label}"
        SELFTEST_PASS=$((SELFTEST_PASS + 1))
    else
        printf '  ✗ %s\n' "${label}"
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

    # --- #500: paths, record identity, and check (g) -----------------------------------------
    echo "merge-guard --selftest: paths, identity, (g)"

    # A relative record path resolves against the CALLER's cwd (never the script's location), and a
    # missing one exits 2 naming the path it resolved — never a bare `cat: no such file`.
    expect_run "a relative record path resolves against the caller's cwd" 0 "${dir}/approve.md" \
        in_dir "${dir}" absolute_path "approve.md"
    expect_run "a missing record exits 2 and names the resolved path" 2 \
        "record: ${dir}/absent.md — not found" \
        in_dir "${dir}" run_guard 412 "absent.md"
    expect_run "an absolute missing record names its absolute path" 2 \
        "record: ${dir}/absent-too.md — not found" \
        run_guard 412 "${dir}/absent-too.md"

    # Record identity: the gate echoes the sha256 of the bytes it read (#500 — a transcribed record
    # once passed a claim about a file the gate never saw).
    local fixture_hash changed_hash
    fixture_hash="$(record_sha256 "${dir}/approve.md")"
    expect_that "record_sha256 prints one sha256 of the file's bytes" \
        grep -qE '^[0-9a-f]{64}$' <<<"${fixture_hash}"
    printf 'one more byte\n' >/dev/null
    cp "${dir}/approve.md" "${dir}/changed-copy.md"
    printf 'and one more\n' >>"${dir}/changed-copy.md"
    changed_hash="$(record_sha256 "${dir}/changed-copy.md")"
    expect_that "record_sha256 changes when the bytes change (it is not a name-derived hash)" \
        test "${fixture_hash}" != "${changed_hash}"

    # --- check (g): the PR body's numbers (#500) --------------------------------------------
    # Network-free by construction: the body and the tool are the two files these cases supply
    # (PR_EVIDENCE_BODY_FILE / PR_EVIDENCE_CMD), and the tool is a stub with the real one's shape.
    mkdir -p "${dir}/stubs"
    cat >"${dir}/stubs/clean.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
    cat >"${dir}/stubs/stale.sh" <<'EOF'
#!/usr/bin/env bash
echo 'pr-evidence: stale-suite (line 5): suite: 88 files / 2604 tests is stale (tree: 89 files / 2675 tests)'
exit 1
EOF
    cat >"${dir}/stubs/missing-block.sh" <<'EOF'
#!/usr/bin/env bash
echo 'pr-evidence: missing-block (line 7): no <!-- pr-evidence:begin --> block, but line 7 states a count — a block is required once the body states one'
exit 2
EOF
    # The FLOW half is stubbed (TEST_FLOW_CMD) so no case needs a git range; the DECLARATION scan
    # stays the real `check-test-budget.mjs --declaration`, so the body fixtures below are judged by
    # the shipped fence/blockquote/pr-evidence-aware parser rather than by a stub that agrees.
    cat >"${dir}/stubs/flow-within.sh" <<'EOF'
#!/usr/bin/env bash
echo 'test-flow: +40/+250 src (allowance 620) — within (base 444454b)'
exit 0
EOF
    cat >"${dir}/stubs/flow-over.sh" <<'EOF'
#!/usr/bin/env bash
echo 'test-flow: +500/+0 src (allowance 120) — over (base 444454b)'
exit 1
EOF
    cat >"${dir}/stubs/flow-error.sh" <<'EOF'
#!/usr/bin/env bash
echo 'test-flow: already-merged (base 444454b) — HEAD is already an ancestor of dev; a post-merge replay must not silently pass.'
exit 2
EOF
    chmod +x "${dir}"/stubs/*.sh

    printf '# Docs only\n\nProse changes; there is nothing to attribute here.\n' >"${dir}/body-docs.md"
    cat >"${dir}/body-stale.md" <<'EOF'
## Evidence

<!-- pr-evidence:begin -->
head: 77338bfc929098cdcdf750a40933660edae6ed3 ← git rev-parse HEAD
suite: 88 files / 2604 tests ← npx vitest run
<!-- pr-evidence:end -->
EOF
    printf '## Evidence\n\nThe suite passes 88 files / 2604 tests.\n' >"${dir}/body-count.md"
    printf '# A flow override\n\nTest budget: +500 test lines buying coverage for the new parser.\n' >"${dir}/body-declared.md"
    printf '# A flow override\n\nTest budget:\n\nThis prose is unrelated to the budget and must not authorise a spend.\n' >"${dir}/body-blank-after-colon.md"
    cat >"${dir}/body-fenced-declaration.md" <<'EOF'
## Evidence

The format is:

```
Test budget: +500 test lines for the new parser
```
EOF
    cat >"${dir}/body-quoted-declaration.md" <<'EOF'
## Evidence

> Test budget: +500 test lines for the new parser
EOF
    cat >"${dir}/body-quoted-count.md" <<'EOF'
## Evidence

An old reading, quoted:

```
88 files / 2604 tests
```

> 88 files / 2604 tests
EOF

    # The check prints its line and the number of reasons it added: a skip adds NONE (it is not a
    # pass, but it cannot block), a block adds exactly one. Every case stubs the flow half so no git
    # range is needed; HEAD_SHA is the fixture head the block cases already use.
    g_case() {
        local label="$1" body="$2" stub="$3" want_line="$4" want_fails="$5" flow_stub="${6:-${dir}/stubs/flow-within.sh}" out saved_head="${HEAD_SHA}"
        PR_EVIDENCE_BODY_FILE="${body}"
        PR_EVIDENCE_CMD=("${stub}")
        TEST_FLOW_CMD=("${flow_stub}")
        HEAD_SHA="77338bfc929098cdcdf750a40933660edae6ed8"
        local before=${#FAIL_REASONS[@]}
        out="$(check_pr_evidence 412 2>&1; printf 'fails=%s' "$((${#FAIL_REASONS[@]} - before))")"
        PR_EVIDENCE_BODY_FILE=""
        PR_EVIDENCE_CMD=()
        TEST_FLOW_CMD=()
        HEAD_SHA="${saved_head}"
        if [[ ${before} -gt 0 ]]; then
            FAIL_REASONS=("${FAIL_REASONS[@]:0:${before}}")
        else
            FAIL_REASONS=()
        fi
        if [[ "${out}" == *"${want_line}"* && "${out}" == *"fails=${want_fails}"* ]]; then
            printf '  ✓ %s\n' "${label}"
            SELFTEST_PASS=$((SELFTEST_PASS + 1))
        else
            printf '  ✗ %s (wanted %s + fails=%s, got: %s)\n' "${label}" "${want_line}" "${want_fails}" "${out//$'\n'/ }"
            SELFTEST_FAIL=$((SELFTEST_FAIL + 1))
        fi
    }

    g_case "(g) a docs-only body with no counts says nothing to recompute" \
        "${dir}/body-docs.md" "${dir}/stubs/clean.sh" "nothing to recompute" 0
    g_case "(g) a count inside a fence or a blockquote is the tool's exemption — skipped" \
        "${dir}/body-quoted-count.md" "${dir}/stubs/clean.sh" "nothing to recompute" 0
    g_case "(g) a stale block body is BLOCKED with the tool's named code" \
        "${dir}/body-stale.md" "${dir}/stubs/stale.sh" "stale-suite" 1
    g_case "(g) a count with no block is BLOCKED as missing-block" \
        "${dir}/body-count.md" "${dir}/stubs/missing-block.sh" "missing-block" 1
    g_case "(g) a clean block passes (g)" \
        "${dir}/body-stale.md" "${dir}/stubs/clean.sh" "recomputes clean" 0
    g_case "(g) a WITHIN flow with a body that declares nothing passes" \
        "${dir}/body-docs.md" "${dir}/stubs/clean.sh" "measured by the cockpit copy" 0

    # --- the flow half on every PR: over needs a declaration, and a declaration is a LINE ---
    # Falsifier 1: an over-allowance PR whose body is plain prose carries no block and no
    # declaration; the gate must block it rather than find nothing to check.
    g_case "(g) an over flow with plain prose and no block is BLOCKED as undeclared" \
        "${dir}/body-docs.md" "${dir}/stubs/clean.sh" "test-flow-undeclared" 1 "${dir}/stubs/flow-over.sh"
    g_case "(g) an over flow WITH a declared line passes, and the line is echoed" \
        "${dir}/body-declared.md" "${dir}/stubs/clean.sh" "test-flow-override" 0 "${dir}/stubs/flow-over.sh"
    g_case "(g) a declaration followed by a BLANK line is not a declaration" \
        "${dir}/body-blank-after-colon.md" "${dir}/stubs/clean.sh" "test-flow-undeclared" 1 "${dir}/stubs/flow-over.sh"
    g_case "(g) a FENCED declaration authorises nothing" \
        "${dir}/body-fenced-declaration.md" "${dir}/stubs/clean.sh" "test-flow-undeclared" 1 "${dir}/stubs/flow-over.sh"
    g_case "(g) a BLOCKQUOTED declaration authorises nothing" \
        "${dir}/body-quoted-declaration.md" "${dir}/stubs/clean.sh" "test-flow-undeclared" 1 "${dir}/stubs/flow-over.sh"
    g_case "(g) an unanswerable flow fails closed with its named reason" \
        "${dir}/body-docs.md" "${dir}/stubs/clean.sh" "already-merged" 1 "${dir}/stubs/flow-error.sh"

    # --- Falsifier 2: the flow verdict cannot be changed by the PR tree -----------------------
    # Two PR trees differ ONLY in scripts/pr-evidence.mjs: one ships a clean tool, the other a
    # tampered one (which reports a stale suite). The block half must see the difference — that
    # proves the tree was read — while the flow half's line must be byte-identical, because it is
    # computed by the cockpit copy.
    mkdir -p "${dir}/clean-tree/scripts" "${dir}/pr-tree/scripts"
    printf 'process.exit(0);\n' >"${dir}/clean-tree/scripts/pr-evidence.mjs"
    printf 'console.log("pr-evidence: stale-suite (line 3): suite: 1 file / 1 test is stale (tree: 2 files / 2 tests)");\nprocess.exit(1);\n' \
        >"${dir}/pr-tree/scripts/pr-evidence.mjs"
    chmod +x "${dir}/clean-tree/scripts/pr-evidence.mjs" "${dir}/pr-tree/scripts/pr-evidence.mjs"
    tree_run() {
        local tree="$1" saved_tree="${PR_TREE_OVERRIDE}" saved_head="${HEAD_SHA}" before out
        PR_EVIDENCE_BODY_FILE="${dir}/body-count.md"
        PR_EVIDENCE_CMD=()
        PR_TREE_OVERRIDE="${tree}"
        TEST_FLOW_CMD=("${dir}/stubs/flow-over.sh")
        HEAD_SHA="77338bfc929098cdcdf750a40933660edae6ed8"
        before=${#FAIL_REASONS[@]}
        out="$(check_pr_evidence 412 2>&1)"
        PR_EVIDENCE_BODY_FILE=""
        PR_EVIDENCE_CMD=()
        PR_TREE_OVERRIDE="${saved_tree}"
        TEST_FLOW_CMD=()
        HEAD_SHA="${saved_head}"
        if [[ ${before} -gt 0 ]]; then
            FAIL_REASONS=("${FAIL_REASONS[@]:0:${before}}")
        else
            FAIL_REASONS=()
        fi
        printf '%s\n' "${out}"
    }
    local clean_out tampered_out clean_flow tampered_flow
    clean_out="$(tree_run "${dir}/clean-tree")"
    tampered_out="$(tree_run "${dir}/pr-tree")"
    clean_flow="$(printf '%s\n' "${clean_out}" | grep -F '(g) test-flow:' | head -1)"
    tampered_flow="$(printf '%s\n' "${tampered_out}" | grep -F '(g) test-flow:' | head -1)"
    if [[ -n "${clean_flow}" && "${clean_flow}" == "${tampered_flow}" ]]; then
        printf '  ✓ (g) the flow line is unchanged by a tampered scripts/pr-evidence.mjs in the PR tree\n'
        SELFTEST_PASS=$((SELFTEST_PASS + 1))
    else
        printf '  ✗ (g) a tampered PR-tree tool must not move the flow line (clean: %s; tampered: %s)\n' \
            "${clean_flow}" "${tampered_flow}"
        SELFTEST_FAIL=$((SELFTEST_FAIL + 1))
    fi
    if [[ "${tampered_out}" == *"stale-suite"* && "${clean_out}" != *"stale-suite"* ]]; then
        printf '  ✓ (g) the block half DID read the PR tree (so the flow case above is not vacuous)\n'
        SELFTEST_PASS=$((SELFTEST_PASS + 1))
    else
        printf '  ✗ (g) the block half should read the PR tree and see its tampered tool (got: %s)\n' \
            "${tampered_out//$'\n'/ }"
        SELFTEST_FAIL=$((SELFTEST_FAIL + 1))
    fi

    # The tree a body's numbers may be measured against: the one at the PR head. A PR head with no
    # local checkout is a NAMED failure, never a check against the caller's tree.
    local self_head
    self_head="$(git -C "${REPO_ROOT}" rev-parse HEAD 2>/dev/null)"
    if [[ -n "${self_head}" ]] && resolve_pr_tree 412 "${self_head}" && [[ -f "${PR_TREE}/scripts/pr-evidence.mjs" ]]; then
        printf '  ✓ (g) a known head resolves to the checkout that has it\n'
        SELFTEST_PASS=$((SELFTEST_PASS + 1))
    else
        printf '  ✗ (g) a known head did not resolve to a checkout (%s)\n' "${PR_TREE_ERROR}"
        SELFTEST_FAIL=$((SELFTEST_FAIL + 1))
    fi
    if ! resolve_pr_tree 412 "0000000000000000000000000000000000000000" && [[ "${PR_TREE_ERROR}" == *"no local checkout"* ]]; then
        printf '  ✓ (g) a head with no local checkout is a named failure\n'
        SELFTEST_PASS=$((SELFTEST_PASS + 1))
    else
        printf '  ✗ (g) an unknown head must fail with a named reason (got: %s)\n' "${PR_TREE_ERROR}"
        SELFTEST_FAIL=$((SELFTEST_FAIL + 1))
    fi

    # The whole run, offline: a stub `gh` on PATH (no network), a fixture subagent log, the fixture
    # provenance, and a stubbed (g). It proves the header echoes BOTH resolved arguments and the
    # record's sha256, and that every check still composes.
    mkdir -p "${dir}/bin"
    cat >"${dir}/bin/gh" <<'EOF'
#!/usr/bin/env bash
echo 'stub-gh: the selftest never touches the network' >&2
exit 1
EOF
    chmod +x "${dir}/bin/gh"
    cat >"${dir}/subagent.log" <<EOF
{"timestamp":"2026-11-08T09:00:00.000Z","message":"Background agent spawned","data":{"agentId":"fixture-agent","task":"Implement it.\n\njev: medium (0.84) · C2 · worktree y"}}
EOF
    printf '2026-11-08T09:00:00.000Z\timpl-500\tjev: medium (0.84) · C2 · worktree y\n' >>"${prov}"
    local header_out header_rc=0 head_hash
    header_out="$(
        cd "${dir}" || exit 1
        JEV_LOG="${dir}/subagent.log"
        PATH="${dir}/bin:${PATH}"
        PR_EVIDENCE_CMD=("${dir}/stubs/stale.sh")
        run_guard 412 "approve.md"
    ) 2>&1" || header_rc=$?
    head_hash="$(record_sha256 "${dir}/approve.md")"
    for want in "pr #412" "record ${dir}/approve.md" "record sha256: ${head_hash}" "(a) CI:" "may mean the PR cannot merge (#465): \`gh pr view 412 --json mergeable,mergeStateStatus\`" "(e) dispatch audit" "(f) recheck" "(g) pr-evidence:"; do
        if [[ "${header_out}" == *"${want}"* ]]; then
            printf '  ✓ the offline run echoes %s\n' "${want}"
            SELFTEST_PASS=$((SELFTEST_PASS + 1))
        else
            printf '  ✗ the offline run must echo %s (got: %s)\n' "${want}" "${header_out//$'\n'/ }"
            SELFTEST_FAIL=$((SELFTEST_FAIL + 1))
        fi
    done
    expect_that "the offline run still blocks when its checks fail (gh is stubbed out)" test "${header_rc}" -eq 1

    local total=$((SELFTEST_PASS + SELFTEST_FAIL))
    echo "merge-guard --selftest: ${SELFTEST_PASS}/${total} passed — $([[ ${SELFTEST_FAIL} -eq 0 ]] && echo PASS || echo FAIL)"
    [[ ${SELFTEST_FAIL} -eq 0 ]]
}

# ── CLI ─────────────────────────────────────────────────────────────────────────────────

# `--pr-tree` names the checkout whose HEAD is the PR head for check (g)'s block half; empty =
# discover it. The flow half never reads a tree.
PR_TREE_OVERRIDE=""

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
            --pr-tree)
                [[ $# -ge 2 ]] || { echo "merge-guard: --pr-tree needs a path" >&2; return 2; }
                PR_TREE_OVERRIDE="$2"
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

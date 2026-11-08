#!/usr/bin/env bash
# run.sh — a command's exit status survives its filter.
#
# Why (U8, issue #504). Two independent measurements — `cmd | tail` and `cmd | grep`, then
# `echo $?` — certified four FAILING review records as exit 0 (U1 acceptance), and the
# implementer's own U4 evidence reported 0 for a tool that had exited 1. Nothing invites
# suspicion: `set -o pipefail` was off, and the filtered output looked right. The status a
# reader sees after `cmd | filter` is the FILTER's, not the command's — silently.
#
#   run --filter 'tail -2' -- bash .pi/skills/worktree/merge-guard.sh --check-record <record>
#
# Usage:
#   run.sh [--filter '<trusted shell>'] [--stderr] [--require-filter|--allow-filter-failure]
#          [--quiet] -- <command> [args...]
#   run.sh --selftest
#
#   --filter '<shell>'      pipe the command's stdout through `sh -c '<shell>'`. The filter is
#                           TRUSTED SHELL CODE — a literal written by the caller, never
#                           interpolated from data, never read from a file, never from a PR body
#                           (the merge gate's rule: body text reaches a parser, not a shell).
#   --stderr                merge the command's stderr into the stream BEFORE the filter
#                           (`2>&1` first). Diagnostics are usually stderr-only — the malformed
#                           review records print 0 bytes on stdout and ~318 on stderr, so a
#                           stdout-only filter shows nothing and looks like a clean pass.
#   --require-filter        the FILTER is the check: a non-zero filter becomes the exit status.
#                           Use it when the filter's verdict is the question (`grep -q`).
#   --allow-filter-failure  keep the default exit status but suppress the non-zero-filter
#                           warning — for a presentation-only filter expected to miss
#                           (`head -1` on a command that prints nothing).
#   --quiet                 do not echo `$ <command>` / `| <filter>` to stderr. The
#                           `run: filter exited <n>` warning still prints: it is the diagnostic.
#
# Exit status: the COMMAND's own status (0/1/2/…), captured from `PIPESTATUS[0]` on the line
# immediately after the pipeline. 141 is a producer killed by SIGPIPE — the command's real status
# (`--filter 'head -1' -- sh -c 'yes'` → 141 on a normal shell), never "completed normally". The
# guarantee is the PRODUCER's status, not the number: a runner that starts the step with SIGPIPE
# ignored (GitHub Actions does; the disposition survives exec) turns the same broken pipe into a
# write error and its own non-zero exit — still the producer's status, still never 0. That
# disposition cannot be restored by a shell, so the selftest has the producer reset it itself
# (`env --default-signal=PIPE`) and asserts 141 on both platforms.
#
# The default is deliberately the COMMAND's status, not the filter's:
#   run --filter 'grep -q NOTHING' -- true   →  0, plus `run: filter exited 1` on stderr
# That is not a bug to "fix" to the filter's status. A vacuous filter (`grep` with no match, a
# filter that does not exist) would then convert every success into a failure and every failure
# into a mystery. It is LOUD instead: every non-zero filter prints `run: filter exited <n>` to
# stderr naming both statuses, and `--require-filter` is the explicit opt-in when the filter IS
# the check.
#
# Helper-owned failures are ALWAYS tagged `run:` because 64 (usage) and 127 (not found) overlap
# legitimate child codes — a child may exit 64 or 127 and that is the child's business:
#   run: usage: …                → 64
#   run: command not found: <c>  → 127 (pre-flighted with `command -v`, so a child that exits
#                                      127 of its own accord prints NO `run:` line)
# Every other exit status comes from the command and carries no `run:` diagnostic.
#
# What this does NOT do (coverage): it is not a test runner; it does not capture, buffer or
# rewrite output (the command's streams are streamed unchanged); it does not time out, retry or
# restart anything; it does not print a tool-wide exit code; and it creates no temp files and no
# state. The filter sees the stream — it never sees the status.
#
# Note on `pipefail`: this script sets it, but it is NOT the mechanism — `pipefail` reports the
# RIGHTMOST non-zero status, so `cmd | filter` under pipefail still loses a failing command
# whenever the filter fails too (and reports the filter when the command was fine). The status is
# read from `PIPESTATUS[0]`. `set -e` is deliberately ABSENT: it can abort the helper between the
# pipeline and the capture, which is the exact loss this script exists to prevent.
#
# Selftest: `run.sh --selftest` runs the revised #504 plan's full table plus both incidences
# (U1's piped merge-guard record, U4's piped tool) as named cases — pre-helper control first,
# with `pipefail` explicitly off, so the defect and its fix are shown side by side. CI runs it
# beside the Jev and sprint-metrics selftests.

set -uo pipefail
# `set +e` explicitly, not merely "unset": a caller may run us under `bash -e` (GitHub Actions'
# default shell is `/usr/bin/bash -e {0}`, and SHELLOPTS can survive into a child), and errexit can
# abort between the pipeline and the PIPESTATUS capture — the exact loss this script exists to
# prevent. Errexit is off by contract, so the capture below always runs.
set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF="${SCRIPT_DIR}/$(basename "${BASH_SOURCE[0]}")"

USAGE_LINE="run.sh [--filter '<trusted shell>'] [--stderr] [--require-filter|--allow-filter-failure] [--quiet] -- <command> [args...]"

usage_error() {
	printf 'run: usage: %s\n' "$1" >&2
	printf 'run: usage: %s\n' "${USAGE_LINE}" >&2
	exit 64
}

# ── The helper ───────────────────────────────────────────────────────────
main() {
	local FILTER=''
	# A filter was GIVEN, even if its value is empty — `--filter ''` is a usage error, not
	# "no filter": an empty filter passes the stream through and quietly re-opens the question.
	local HAS_FILTER=0
	local MERGE_STDERR=0
	local QUIET=0
	# warn (default) · require (--require-filter) · ignore (--allow-filter-failure)
	local FILTER_POLICY='warn'
	local DO_SELFTEST=0
	local SAW_SEPARATOR=0
	local CMD=()

	while (( $# > 0 )); do
		case "$1" in
			--filter)
				(( $# >= 2 )) || usage_error "--filter needs a shell filter argument"
				FILTER="$2"
				HAS_FILTER=1
				shift 2
				;;
			--filter=*)
				FILTER="${1#*=}"
				HAS_FILTER=1
				shift
				;;
			--stderr) MERGE_STDERR=1; shift ;;
			--quiet|-q) QUIET=1; shift ;;
			--require-filter)
				[[ "${FILTER_POLICY}" == 'ignore' ]] &&
					usage_error "--require-filter and --allow-filter-failure are mutually exclusive"
				FILTER_POLICY='require'
				shift
				;;
			--allow-filter-failure)
				[[ "${FILTER_POLICY}" == 'require' ]] &&
					usage_error "--require-filter and --allow-filter-failure are mutually exclusive"
				FILTER_POLICY='ignore'
				shift
				;;
			--selftest) DO_SELFTEST=1; shift ;;
			--)
				shift
				CMD=("$@")
				SAW_SEPARATOR=1
				break
				;;
			*)
				# `--filter 'tail -1'` with no `--` is the common slip: the command would be
				# swallowed as another option. Say so instead of running something else.
				usage_error "unexpected argument '$1' — options come first, then '--', then the command"
				;;
		esac
	done

	if (( DO_SELFTEST == 1 )); then
		selftest
		exit $?
	fi

	(( SAW_SEPARATOR == 1 )) || usage_error "missing '--' before the command"
	(( ${#CMD[@]} > 0 )) || usage_error "no command given after '--'"
	if (( HAS_FILTER == 1 )) && [[ -z "${FILTER// /}" ]]; then
		usage_error "--filter needs a non-empty shell filter (an empty one would pass the stream through unfiltered)"
	fi

	# A missing command is HELPER-owned (127) and caught before anything runs — so a child that
	# exits 127 of its own accord is never confused with a typo in the helper invocation.
	if ! command -v "${CMD[0]}" >/dev/null 2>&1; then
		printf 'run: command not found: %s — nothing was run (127)\n' "${CMD[0]}" >&2
		exit 127
	fi

	if (( QUIET == 0 )); then
		printf '$ ' >&2
		printf '%q ' "${CMD[@]}" >&2
		printf '\n' >&2
		if (( HAS_FILTER == 1 )); then
			printf '| %s\n' "${FILTER}" >&2
		fi
	fi

	local cmd_status=0
	local filter_status=0
	local -a statuses=()

	if (( HAS_FILTER == 1 )); then
		# The capture MUST be the statement immediately after the pipeline: anything in between
		# (even a `printf`) overwrites PIPESTATUS. That adjacency requirement is why the two
		# arms repeat one line instead of sharing a helper — correctness beats DRY at two lines.
		if (( MERGE_STDERR == 1 )); then
			"${CMD[@]}" 2>&1 | sh -c "${FILTER}"
			statuses=("${PIPESTATUS[@]}")
		else
			"${CMD[@]}" | sh -c "${FILTER}"
			statuses=("${PIPESTATUS[@]}")
		fi
		cmd_status="${statuses[0]}"
		filter_status="${statuses[1]:-0}"
	else
		"${CMD[@]}"
		cmd_status=$?
	fi

	# A non-zero filter is a DIAGNOSTIC, never the status — unless --require-filter says the
	# filter is the check. A vacuous or broken filter must be impossible to mistake for a pass.
	if (( HAS_FILTER == 1 )) && (( filter_status != 0 )); then
		case "${FILTER_POLICY}" in
			ignore) ;;
			require)
				printf 'run: filter exited %d — --require-filter: exiting %d (the command exited %d)\n' \
					"${filter_status}" "${filter_status}" "${cmd_status}" >&2
				exit "${filter_status}"
				;;
			*)
				printf 'run: filter exited %d — the exit status is the command'"'"'s (%d); pass --require-filter if the filter is the check\n' \
					"${filter_status}" "${cmd_status}" >&2
				;;
		esac
	fi

	exit "${cmd_status}"
}

# ── Selftest ─────────────────────────────────────────────────────────────
# The revised #504 plan's table, plus the two incidences as named cases. Network-free; the only
# filesystem use is one `mktemp -d` scratch dir. Every case invokes this same script as a CHILD
# process, so what is proven is the shipped entry point — not a re-implementation of it.
selftest() {
	local tmpd
	tmpd="$(mktemp -d)" || { printf 'run: selftest: cannot create a scratch dir\n' >&2; return 2; }
	# shellcheck disable=SC2064 # expand now: the dir is known, and the trap must not re-read a local
	trap "rm -rf '${tmpd}'" EXIT

	local _rc=0
	local st_pass=0
	local st_fail=0
	local CASE_NAME=''
	local -a CASE_WHY=()

	ok() { printf '  ✓ %s\n' "$1"; }
	bad() { printf '  ✗ %s\n' "$1"; }

	case_begin() { CASE_NAME="$1"; CASE_WHY=(); }

	assert_rc() {
		(( _rc == $1 )) && return 0
		CASE_WHY+=("exit: want $1, got ${_rc}")
	}

	# Fixed-string substring assertions: a diagnostic is quoted, never regex-matched.
	assert_err_has() { grep -Fq -- "$1" "${tmpd}/err" || CASE_WHY+=("stderr: missing '$1'"); }
	assert_err_lacks() { ! grep -Fq -- "$1" "${tmpd}/err" || CASE_WHY+=("stderr: unexpected '$1'"); }
	assert_out_has() { grep -Fq -- "$1" "${tmpd}/out" || CASE_WHY+=("stdout: missing '$1'"); }
	assert_out_lacks() { ! grep -Fq -- "$1" "${tmpd}/out" || CASE_WHY+=("stdout: unexpected '$1'"); }
	assert_out_empty() {
		[[ ! -s "${tmpd}/out" ]] ||
			CASE_WHY+=("stdout: expected empty, got '$(head -c 120 "${tmpd}/out" | tr '\n' ' ')'")
	}

	case_end() {
		if (( ${#CASE_WHY[@]} == 0 )); then
			ok "${CASE_NAME}"
			(( st_pass += 1 ))
		else
			bad "${CASE_NAME}"
			printf '        %s\n' "${CASE_WHY[@]}"
			printf '        [stderr] %s\n' "$(tr '\n' '|' <"${tmpd}/err")"
			(( st_fail += 1 ))
		fi
	}

	invoke() {
		: >"${tmpd}/out"
		: >"${tmpd}/err"
		bash "${SELF}" "$@" >"${tmpd}/out" 2>"${tmpd}/err"
		_rc=$?
	}

	printf 'run: selftest — %s\n' "${SELF}"

	# ── 1. The command's status passes through untouched ──────────────────
	case_begin 'true → 0, and the echo names the command'
	invoke -- true
	assert_rc 0
	assert_err_has '$ true'
	case_end

	case_begin 'false → 1'
	invoke -- false
	assert_rc 1
	case_end

	case_begin "sh -c 'exit 2' → 2"
	invoke -- sh -c 'exit 2'
	assert_rc 2
	case_end

	case_begin "child 'exit 64' → 64 with NO run: line (64 overlaps the usage code)"
	invoke -- sh -c 'exit 64'
	assert_rc 64
	assert_err_lacks 'run:'
	case_end

	case_begin "child 'exit 127' → 127 with NO run: line (127 overlaps not-found)"
	invoke -- sh -c 'exit 127'
	assert_rc 127
	assert_err_lacks 'run:'
	case_end

	# ── 2. The filter does not own the status ─────────────────────────────
	case_begin "--filter 'tail -1' -- false → 1 (the filter succeeds; the command's status wins)"
	invoke --filter 'tail -1' -- false
	assert_rc 1
	assert_err_has '| tail -1'
	assert_err_lacks 'run: filter exited'
	case_end

	case_begin "--filter 'head -1' -- sh -c 'echo x; exit 3' → 3"
	invoke --filter 'head -1' -- sh -c 'echo x; exit 3'
	assert_rc 3
	case_end

	# ── 3. The vacuous filter: loud by default, authoritative on request ──
	case_begin "--filter 'grep -q NOTHING' -- true → 0 AND 'run: filter exited 1' (loud, not silent)"
	invoke --filter 'grep -q NOTHING' -- true
	assert_rc 0
	assert_err_has 'run: filter exited 1'
	case_end

	case_begin 'the same with --require-filter → 1 (the filter IS the check)'
	invoke --require-filter --filter 'grep -q NOTHING' -- true
	assert_rc 1
	assert_err_has 'run: filter exited 1'
	case_end

	case_begin 'the same with --allow-filter-failure → 0 and no warning (presentation-only filter)'
	invoke --allow-filter-failure --filter 'grep -q NOTHING' -- true
	assert_rc 0
	assert_err_lacks 'run: filter'
	case_end

	case_begin '--require-filter with --allow-filter-failure → 64 (contradictory)'
	invoke --require-filter --allow-filter-failure --filter 'grep -q NOTHING' -- true
	assert_rc 64
	assert_err_has 'run: usage'
	case_end

	# ── 4. A broken filter is loud, and still not the status ──────────────
	case_begin "--filter 'no_such_cmd_504' -- true → 0 plus 'run: filter exited 127'"
	invoke --filter 'no_such_cmd_504' -- true
	assert_rc 0
	assert_err_has 'run: filter exited 127'
	case_end

	case_begin "--filter 'no_such_cmd_504' -- false → 1 plus 'run: filter exited 127'"
	invoke --filter 'no_such_cmd_504' -- false
	assert_rc 1
	assert_err_has 'run: filter exited 127'
	case_end

	# ── 5. SIGPIPE is the producer's real status ──────────────────────────
	# The DISPOSITION is inherited through exec, and a shell cannot restore a SIGPIPE that was
	# already ignored when it started: on a runner that ignores SIGPIPE at startup (GitHub Actions
	# does) `yes` gets EPIPE instead of a signal, prints "standard output: Broken pipe" and exits
	# 1 — locally the same producer dies of SIGPIPE and reports 141. The helper cannot change
	# that and must not: it reports the PRODUCER's status either way. coreutils' env(1) CAN
	# restore the default, so the producer resets the disposition itself and the case asserts
	# the signal death deterministically on both platforms.
	# Guard: an env(1) without --default-signal cannot set this up — say so, never pass quietly.
	if env --help 2>/dev/null | grep -q -- '--default-signal'; then
		case_begin "SIGPIPE: --filter 'head -1' -- env --default-signal=PIPE yes → 141 (the producer's real status)"
		invoke --filter 'head -1' -- env --default-signal=PIPE yes
		assert_rc 141
		assert_err_lacks 'run: filter exited'
		case_end
	else
		printf '  ~ SIGPIPE case SKIPPED (stated, not silent): this env(1) has no --default-signal, so a\n'
		printf '    platform that inherited SIGPIPE as ignored cannot be made to show the 141 death here\n'
	fi

	# ── 6. Streams: --stderr decides whether diagnostics reach the filter ─
	case_begin 'a stderr-only producer, stdout-only filter → text not in the filtered stream, status kept'
	invoke --filter 'cat' -- sh -c 'echo out-line; echo err-line >&2; exit 0'
	assert_rc 0
	assert_out_has 'out-line'
	assert_out_lacks 'err-line'
	assert_err_has 'err-line' # it still reaches the terminal, just not the filter
	case_end

	case_begin 'the same with --stderr → the text IS in the filtered stream, status kept'
	invoke --stderr --filter 'cat' -- sh -c 'echo out-line; echo err-line >&2; exit 0'
	assert_rc 0
	assert_out_has 'out-line'
	assert_out_has 'err-line'
	case_end

	case_begin '--stderr on a FAILING stderr-only producer → status kept, text visible'
	invoke --stderr --filter 'cat' -- sh -c 'echo err-only >&2; exit 5'
	assert_rc 5
	assert_out_has 'err-only'
	case_end

	case_begin 'without --stderr the same producer leaves the filtered stream empty (status still 5)'
	invoke --filter 'cat' -- sh -c 'echo err-only >&2; exit 5'
	assert_rc 5
	assert_out_empty
	case_end

	# ── 7. argv reaches the child literally ──────────────────────────────
	case_begin 'an argument with a space and $(...) reaches the child literally (no re-parsing)'
	invoke -- printf '%s\n' 'a b $(id -u) ; |'
	assert_rc 0
	assert_out_has 'a b $(id -u) ; |'
	case_end

	case_begin 'the same argv with a filter still reaches the child literally'
	invoke --filter 'tail -1' -- printf '%s\n' 'x y $(id -u)'
	assert_rc 0
	assert_out_has 'x y $(id -u)'
	case_end

	# ── 8. Helper-owned failures are tagged and distinguishable ──────────
	case_begin 'missing command → 127 with a run: line'
	invoke -- no_such_cmd_504 --flag
	assert_rc 127
	assert_err_has 'run: command not found: no_such_cmd_504'
	case_end

	case_begin "no '--' → 64 with a run: line"
	invoke --filter 'tail -1' true
	assert_rc 64
	assert_err_has 'run: usage'
	case_end

	case_begin "'--' with no command → 64 with a run: line"
	invoke --
	assert_rc 64
	assert_err_has 'run: usage'
	case_end

	case_begin '--filter with no value → 64 with a run: line'
	invoke --filter
	assert_rc 64
	assert_err_has 'run: usage'
	case_end

	case_begin "an empty --filter '' → 64 with a run: line"
	invoke --filter '' -- true
	assert_rc 64
	assert_err_has 'run: usage'
	case_end

	case_begin 'an unknown option → 64 with a run: line'
	invoke --bogus -- true
	assert_rc 64
	assert_err_has 'run: usage'
	case_end

	# ── 9. --quiet silences the echo, never the diagnostic ───────────────
	case_begin '--quiet -- true → 0 with no echo'
	invoke --quiet -- true
	assert_rc 0
	assert_err_lacks '$ true'
	case_end

	case_begin '--quiet keeps the non-zero-filter warning'
	invoke --quiet --filter 'grep -q NOTHING' -- true
	assert_rc 0
	assert_err_has 'run: filter exited 1'
	case_end

	# ── 10. The incidences, replayed as named cases ──────────────────────
	# U1: a FAILING merge-guard record read through `tail`. Pre-helper control FIRST, with
	# `pipefail` explicitly off — the shell the incident ran in.
	local record='scripts/__tests__/fixtures/review-records/s4-no-recheck.md'
	local fixture
	for fixture in s4-no-recheck s5-fused-fields s6-findings-bank; do
		record="scripts/__tests__/fixtures/review-records/${fixture}.md"
		if [[ -f "${SCRIPT_DIR}/../../../${record}" ]]; then
			case_begin "U1 pre-helper control: merge-guard --check-record <${fixture}> | tail -2 → 0 (THE DEFECT)"
			(set +o pipefail
				bash "${SCRIPT_DIR}/merge-guard.sh" --check-record "${SCRIPT_DIR}/../../../${record}" 2>&1 | tail -2 >/dev/null)
			_rc=$?
			assert_rc 0
			case_end

			case_begin "U1 through run: merge-guard --check-record <${fixture}> → 1, the reason visible"
			invoke --filter 'tail -2' --stderr -- bash "${SCRIPT_DIR}/merge-guard.sh" --check-record "${SCRIPT_DIR}/../../../${record}"
			assert_rc 1
			assert_out_has 'is not a record the gate can read'
			case_end
		else
			printf '  ~ fixture %s not found — U1 replay skipped (this is a finding, not a pass)\n' "${record}"
		fi
	done

	# The risk-weaker CLI case from the same incident: no filter hides it — the tool itself
	# refuses a declared tier weaker than the recheck. Pinned here so the replay matches the plan.
	case_begin 'U1 risk-weaker CLI: review-record refuses C3 declared over a C2 recheck → 1'
	invoke -- node "${SCRIPT_DIR}/../../../scripts/review-record.mjs" --pr 1 --verdict approve \
		--head 0123456789abcdef0123456789abcdef01234567 --risk C3 \
		--recheck 'jev: medium (0.75) · C2 · worktree y' --findings - </dev/null
	assert_rc 1
	assert_err_has 'risk-weaker-than-recheck'
	case_end

	# U4: a tool exiting 1 with its output piped to `grep`, reported as 0. The original pipeline
	# was never preserved — this is a NAMED SYNTHETIC, not the historical run.
	case_begin 'U4 pre-helper control: sh -c "echo finding; exit 1" | grep -q finding → 0 (THE DEFECT)'
	(set +o pipefail
		sh -c 'echo finding; exit 1' | grep -q finding)
	_rc=$?
	assert_rc 0
	case_end

	case_begin 'U4 through run: --filter "grep -q finding" on the same tool → 1'
	invoke --filter 'grep -q finding' -- sh -c 'echo finding; exit 1'
	assert_rc 1
	case_end

	printf 'run: selftest %s — %d case(s) passed, %d failed\n' \
		"$([[ ${st_fail} -eq 0 ]] && echo OK || echo FAILED)" "${st_pass}" "${st_fail}"
	(( st_fail == 0 )) || return 1
	return 0
}

main "$@"
